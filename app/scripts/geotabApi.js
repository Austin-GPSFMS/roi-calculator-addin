/**
 * Service to handle data fetching from Geotab API
 *
 * Designed to be resilient:
 * - Each data function silently returns empty/safe defaults on failure rather than throwing.
 * - This ensures partial data is always rendered even if some calls fail.
 * - ExceptionEvents use paginated date-advancing Get (50K per page).
 * - Utilization uses chunked odometer reads (2 per device) with a small delay between chunks
 *   to avoid overwhelming the API at high concurrency.
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

    /** Small delay helper to avoid rate-limit bursts */
    _sleep: function (ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    },

    /**
     * Run calls in sequential chunks with a small delay between each chunk.
     * Chunk size of 200 is conservative to avoid overloading the API on larger databases.
     * Delay of 150ms between chunks prevents burst rate-limiting.
     */
    _runChunkedMultiCall: async function (calls, chunkSize = 200, delayMs = 150) {
        let allResults = [];
        for (let i = 0; i < calls.length; i += chunkSize) {
            const chunk = calls.slice(i, i + chunkSize);
            const res = await this._multiCall(chunk);
            allResults = allResults.concat(res);
            if (i + chunkSize < calls.length) {
                await this._sleep(delayMs);
            }
        }
        return allResults;
    },

    /**
     * Auto-determines bucket granularity for trend chart based on range length.
     */
    _getAutoBucketSize: function (fromDate, toDate) {
        const days = (toDate - fromDate) / (1000 * 60 * 60 * 24);
        if (days <= 14) return 'daily';
        if (days <= 90) return 'weekly';
        return 'monthly';
    },

    /**
     * Given a date and bucket size, return a bucket key string for grouping.
     */
    _getBucketKey: function (date, bucketSize) {
        const d = new Date(date);
        if (bucketSize === 'daily') {
            return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        }
        if (bucketSize === 'weekly') {
            const weekStart = new Date(d);
            weekStart.setDate(d.getDate() - d.getDay());
            return 'W/' + weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        }
        return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    },

    /**
     * Build an ordered list of unique bucket labels for the full date range.
     */
    _buildBucketLabels: function (fromDate, toDate, bucketSize) {
        const labels = [];
        const seen = new Set();
        let curr = new Date(fromDate);
        let failsafe = 0;

        while (curr <= toDate && failsafe < 1000) {
            const key = this._getBucketKey(curr, bucketSize);
            if (!seen.has(key)) {
                labels.push(key);
                seen.add(key);
            }
            if (bucketSize === 'daily') curr.setDate(curr.getDate() + 1);
            else if (bucketSize === 'weekly') curr.setDate(curr.getDate() + 7);
            else curr.setMonth(curr.getMonth() + 1);
            failsafe++;
        }
        return labels;
    },

    /**
     * Paginated fetch for ExceptionEvents by a single rule ID.
     * Fetches up to PAGE_SIZE records per call and advances fromDate past the last record.
     * Returns empty array if the rule doesn't exist or any error occurs (silent degradation).
     */
    _feedExceptionEvents: async function (ruleId, fromDate, toDate) {
        const PAGE_SIZE = 50000;
        let allEvents = [];
        let currentFromDate = new Date(fromDate);

        while (currentFromDate < toDate) {
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
                // Rule doesn't exist in this DB, or query failed — skip silently
                console.warn(`ExceptionEvent fetch skipped for rule "${ruleId}":`, err.message || err);
                break;
            }

            if (!results || results.length === 0) break;

            allEvents = allEvents.concat(results);

            if (results.length < PAGE_SIZE) break; // Consumed all data

            // Advance to just after the last event's time
            const lastTime = new Date(results[results.length - 1].activeTo || results[results.length - 1].activeFrom);
            currentFromDate = new Date(lastTime.getTime() + 1);
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
            return []; // Return empty rather than crashing
        }
    },

    /**
     * Get Device Groups map and the raw group list.
     * Never throws — returns empty maps on failure.
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
            console.warn("Error fetching groups (non-fatal):", e);
            return { map: {}, rawGroups: [] };
        }
    },

    /**
     * Get idle duration per device + auto-bucketed trend data.
     * Returns safe empty defaults on failure.
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

                const key = this._getBucketKey(event.activeFrom, bucketSize);
                if (key in bucketHours) bucketHours[key] += hours;
            });

            const trendData = bucketLabels.map(l => ({ label: l, value: bucketHours[l] || 0 }));
            return { totalHours, deviceIdling, trendData, bucketSize };
        } catch (e) {
            console.warn("Error fetching idle data (non-fatal):", e);
            return { totalHours: 0, deviceIdling: {}, trendData: [], bucketSize: 'monthly' };
        }
    },

    /**
     * Get harsh driving event counts per device + trend data.
     * Each rule is fetched independently. Failures on individual rules are silent.
     * Returns safe empty defaults on overall failure.
     */
    getHarshDrivingPerDevice: async function (devices, fromDate, toDate) {
        try {
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
                    if (key in bucketCounts) bucketCounts[key]++;
                });
                // Small pause between rule fetches
                await this._sleep(100);
            }

            const trendData = bucketLabels.map(l => ({ label: l, value: bucketCounts[l] || 0 }));
            return { totalCount, deviceHarshCounts, trendData, bucketSize };
        } catch (e) {
            console.warn("Error fetching harsh driving data (non-fatal):", e);
            return { totalCount: 0, deviceHarshCounts: {}, trendData: [], bucketSize: 'monthly' };
        }
    },

    /**
     * Get utilization per device using 2 odometer reads (start + end of period).
     * Chunked into small batches with delays to avoid overwhelming the API.
     * Returns safe empty defaults on failure.
     */
    getUtilizationPerDevice: async function (devices, fromDate, toDate) {
        try {
            if (!devices || devices.length === 0) {
                return { underutilizedCount: 0, deviceUtilization: {} };
            }

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

            // Run sequentially (not in parallel) to avoid overwhelming the connection pool
            const startResults = await this._runChunkedMultiCall(startCalls);
            await this._sleep(250); // Brief pause between start and end reads
            const endResults = await this._runChunkedMultiCall(endCalls);

            const deviceUtilization = {};
            let underutilizedCount = 0;

            devices.forEach((d, i) => {
                const startOdo = startResults[i] && startResults[i].length > 0 ? startResults[i][0].data : null;
                const endOdo = endResults[i] && endResults[i].length > 0 ? endResults[i][0].data : null;

                let isUnderutilized;
                if (startOdo !== null && endOdo !== null) {
                    isUnderutilized = Math.abs(endOdo - startOdo) < 2000; // < 2km = stationary
                } else {
                    isUnderutilized = true; // No odometer data = offline/untracked for period
                }

                deviceUtilization[d.id] = isUnderutilized;
                if (isUnderutilized) underutilizedCount++;
            });

            return { underutilizedCount, deviceUtilization };
        } catch (e) {
            console.warn("Error fetching utilization data (non-fatal):", e);
            return { underutilizedCount: 0, deviceUtilization: {} };
        }
    }
};
