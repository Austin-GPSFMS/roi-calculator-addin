/**
 * Service to handle data fetching from Geotab API
 *
 * Designed to scale to 10,000 vehicle fleets with 1 year of data.
 *
 * Core strategy:
 *  - ExceptionEvents: Paginated Get requests (50K records/page), advancing fromDate
 *    past the last record each page. Results are then bucketed client-side into trend
 *    periods - zero extra API calls needed regardless of fleet size or date range.
 *
 *  - Utilization: 2 odometer reads per device (start/end of range) via chunked
 *    multiCalls of 500. For 10K devices = 40 chunks total, very manageable.
 *
 *  Auto-bucketing for trend chart:
 *    <= 14 days  → Daily buckets
 *    <= 90 days  → Weekly buckets
 *    > 90 days   → Monthly buckets
 */
window.GeotabApiService = function (api) {
    this.api = api;
};

window.GeotabApiService.prototype = {

    /** Single API call */
    _call: function (method, params) {
        return new Promise((resolve, reject) => {
            this.api.call(method, params, resolve, reject);
        });
    },

    /** Multi-call (array of [method, params]) */
    _multiCall: function (calls) {
        return new Promise((resolve, reject) => {
            this.api.multiCall(calls, resolve, reject);
        });
    },

    /**
     * Run calls in sequential chunks to avoid Geotab's concurrent request limits.
     * Chunk size of 500 is safe for any Geotab database.
     */
    _runChunkedMultiCall: async function (calls, chunkSize = 500) {
        let allResults = [];
        for (let i = 0; i < calls.length; i += chunkSize) {
            const chunk = calls.slice(i, i + chunkSize);
            const res = await this._multiCall(chunk);
            allResults = allResults.concat(res);
        }
        return allResults;
    },

    /**
     * Determine auto bucket size based on the date range length.
     * This keeps the trend chart meaningful without user input.
     */
    _getAutoBucketSize: function (fromDate, toDate) {
        const days = (toDate - fromDate) / (1000 * 60 * 60 * 24);
        if (days <= 14) return 'daily';
        if (days <= 90) return 'weekly';
        return 'monthly';
    },

    /**
     * Given a date and a bucket size, return the bucket key for grouping.
     * e.g. daily => "Mar 4", weekly => "W/Mar 3", monthly => "Mar 2026"
     */
    _getBucketKey: function (date, bucketSize) {
        const d = new Date(date);
        if (bucketSize === 'daily') {
            return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        }
        if (bucketSize === 'weekly') {
            const weekStart = new Date(d);
            weekStart.setDate(d.getDate() - d.getDay()); // Sunday of that week
            return 'W/' + weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        }
        return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    },

    /**
     * Build an ordered list of bucket labels between fromDate and toDate.
     */
    _buildBucketLabels: function (fromDate, toDate, bucketSize) {
        const labels = [];
        const seen = new Set();
        let curr = new Date(fromDate);

        while (curr <= toDate) {
            const key = this._getBucketKey(curr, bucketSize);
            if (!seen.has(key)) {
                labels.push(key);
                seen.add(key);
            }
            if (bucketSize === 'daily') curr.setDate(curr.getDate() + 1);
            else if (bucketSize === 'weekly') curr.setDate(curr.getDate() + 7);
            else curr.setMonth(curr.getMonth() + 1);
        }
        return labels;
    },

    /**
     * Stream ALL ExceptionEvents for a rule using auto-paginated Get calls.
     *
     * Each page requests up to 50,000 records. When we get a full page, we advance
     * fromDate to just after the last record's activeTo and request the next page.
     * This continues until the results are smaller than PAGE_SIZE (end of data).
     *
     * No matter how large the fleet or date range, each individual HTTP request
     * is always bounded to a single JSON response, and we never exceed Geotab limits.
     */
    _feedExceptionEvents: async function (ruleId, fromDate, toDate) {
        const PAGE_SIZE = 50000;
        let allEvents = [];
        let currentFromDate = new Date(fromDate);

        while (true) {
            let results;
            try {
                results = await this._call("Get", {
                    typeName: "ExceptionEvent",
                    search: {
                        fromDate: currentFromDate.toISOString(),
                        toDate: toDate.toISOString(),
                        ruleSearch: { id: ruleId }
                    },
                    resultsLimit: PAGE_SIZE
                });
            } catch (err) {
                console.warn(`ExceptionEvent fetch failed for rule ${ruleId}:`, err);
                break;
            }

            if (!results || results.length === 0) break;

            allEvents = allEvents.concat(results);

            if (results.length < PAGE_SIZE) break; // All data consumed

            // Advance to just after the last record
            const lastTime = new Date(results[results.length - 1].activeTo || results[results.length - 1].activeFrom);
            currentFromDate = new Date(lastTime.getTime() + 1);

            if (currentFromDate >= toDate) break;
        }

        return allEvents;
    },

    /**
     * Get active devices, filtering out archived/terminated vehicles.
     */
    getDevices: async function () {
        try {
            const devices = await this._call("Get", { typeName: "Device" });
            const now = new Date();
            return devices.filter(d => d.activeTo && new Date(d.activeTo) > now);
        } catch (e) {
            console.error("Error fetching devices", e);
            throw e;
        }
    },

    /**
     * Get Device Groups map and the raw group list (for hierarchy dropdown).
     */
    getDeviceGroupsMap: async function () {
        try {
            const results = await this._multiCall([
                ["Get", { typeName: "Device" }],
                ["Get", { typeName: "Group" }]
            ]);

            const devices = results[0] || [];
            const groups = results[1] || [];

            const groupNameMap = {};
            groups.forEach(g => { groupNameMap[g.id] = g.name; });

            const deviceGroupMap = {};
            devices.forEach(d => {
                const names = [];
                if (d.groups) {
                    d.groups.forEach(g => {
                        if (groupNameMap[g.id]) names.push(groupNameMap[g.id]);
                        if (!deviceGroupMap[d.id + '_ids']) deviceGroupMap[d.id + '_ids'] = [];
                        deviceGroupMap[d.id + '_ids'].push(g.id);
                    });
                }
                deviceGroupMap[d.id] = names.join(", ");
            });

            return { map: deviceGroupMap, rawGroups: groups };
        } catch (e) {
            console.error("Error fetching groups", e);
            return { map: {}, rawGroups: [] };
        }
    },

    /**
     * Get idle duration per device + trend data (bucketed client-side).
     * Uses paginated Get — no rate limit issues.
     */
    getIdleDurationPerDevice: async function (devices, fromDate, toDate) {
        try {
            const bucketSize = this._getAutoBucketSize(fromDate, toDate);
            const bucketLabels = this._buildBucketLabels(fromDate, toDate, bucketSize);
            const bucketHours = {};
            bucketLabels.forEach(l => { bucketHours[l] = 0; });

            const events = await this._feedExceptionEvents("aU_66pnHj8EeIWFcP8CcX7Q", fromDate, toDate);

            const deviceIdling = {};
            let totalHours = 0;

            events.forEach(event => {
                if (!event.device || !event.device.id) return;
                const devId = event.device.id;
                const hours = (new Date(event.activeTo) - new Date(event.activeFrom)) / 3600000;
                deviceIdling[devId] = (deviceIdling[devId] || 0) + hours;
                totalHours += hours;

                // Bucket by event start date
                const key = this._getBucketKey(event.activeFrom, bucketSize);
                if (bucketHours[key] !== undefined) bucketHours[key] += hours;
            });

            const trendData = bucketLabels.map(l => ({ label: l, value: bucketHours[l] || 0 }));
            return { totalHours, deviceIdling, trendData, bucketSize };
        } catch (e) {
            console.error("Error fetching idle data", e);
            throw e;
        }
    },

    /**
     * Get harsh driving event counts per device + trend data (bucketed client-side).
     */
    getHarshDrivingPerDevice: async function (devices, fromDate, toDate) {
        const bucketSize = this._getAutoBucketSize(fromDate, toDate);
        const bucketLabels = this._buildBucketLabels(fromDate, toDate, bucketSize);
        const bucketCounts = {};
        bucketLabels.forEach(l => { bucketCounts[l] = 0; });

        const deviceHarshCounts = {};
        let totalCount = 0;

        const ruleIds = [
            "RuleJackrabbitStartsId",
            "RuleHarshBrakingId",
            "RuleHarshCorneringId"
        ];

        for (const ruleId of ruleIds) {
            const events = await this._feedExceptionEvents(ruleId, fromDate, toDate);

            events.forEach(event => {
                if (!event.device || !event.device.id) return;
                const devId = event.device.id;
                deviceHarshCounts[devId] = (deviceHarshCounts[devId] || 0) + 1;
                totalCount++;

                const key = this._getBucketKey(event.activeFrom, bucketSize);
                if (bucketCounts[key] !== undefined) bucketCounts[key]++;
            });
        }

        const trendData = bucketLabels.map(l => ({ label: l, value: bucketCounts[l] || 0 }));
        return { totalCount, deviceHarshCounts, trendData, bucketSize };
    },

    /**
     * Get utilization per device: exactly 2 odometer reads per vehicle (start/end).
     * Chunked into batches of 500 — handles 10K device fleets in ~40 API round-trips.
     */
    getUtilizationPerDevice: async function (devices, fromDate, toDate) {
        try {
            const startCalls = devices.map(d => ["Get", {
                typeName: "StatusData",
                search: {
                    deviceSearch: { id: d.id },
                    diagnosticSearch: { id: "DiagnosticOdometerId" },
                    fromDate: fromDate.toISOString()
                },
                resultsLimit: 1
            }]);

            const endCalls = devices.map(d => ["Get", {
                typeName: "StatusData",
                search: {
                    deviceSearch: { id: d.id },
                    diagnosticSearch: { id: "DiagnosticOdometerId" },
                    fromDate: toDate.toISOString()
                },
                resultsLimit: 1
            }]);

            const [startResults, endResults] = await Promise.all([
                this._runChunkedMultiCall(startCalls),
                this._runChunkedMultiCall(endCalls)
            ]);

            const deviceUtilization = {};
            let underutilizedCount = 0;

            devices.forEach((d, i) => {
                const startOdo = startResults[i] && startResults[i].length > 0 ? startResults[i][0].data : null;
                const endOdo = endResults[i] && endResults[i].length > 0 ? endResults[i][0].data : null;

                let isUnderutilized;
                if (startOdo !== null && endOdo !== null) {
                    isUnderutilized = Math.abs(endOdo - startOdo) < 2000; // < 2km = stationary
                } else {
                    isUnderutilized = true; // No odometer data = assume offline/untracked
                }

                deviceUtilization[d.id] = isUnderutilized;
                if (isUnderutilized) underutilizedCount++;
            });

            return { underutilizedCount, deviceUtilization };
        } catch (e) {
            console.error("Error fetching utilization data", e);
            throw e;
        }
    }
};
