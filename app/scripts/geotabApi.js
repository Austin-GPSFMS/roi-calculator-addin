/**
 * GeotabApiService
 *
 * Optimized for 10,000+ vehicle fleets and long date ranges.
 *
 * Merged Strategy:
 *  - Sorted Paging: Uses `sort` on ExceptionEvents to ensure paging sliding window is 100% reliable.
 *  - UI Yielding: Uses `setTimeout(0)` to yield the main thread between network chunks, keeping browser responsive.
 *  - Silent Resiliency: Individual failures (missing rules, single device timeouts) degrade gracefully.
 *  - Chunked Requests: Limits concurrency with delays to prevent API rate-limiting.
 */
window.GeotabApiService = function (api) {
    this.api = api;

    // Configurable scaling parameters
    this.EXCEPTION_PAGE_SIZE = 10000;
    this.MULTICALL_CHUNK_SIZE = 200; // Conservative chunk size for high volume DBs
    this.MULTICALL_DELAY_MS = 150;
    this.ODO_DIAGNOSTIC_ID = "DiagnosticOdometerId";
    this.IDLE_RULE_ID = "aU_66pnHj8EeIWFcP8CcX7Q";
};

window.GeotabApiService.prototype = {

    /** Single API call wrapper */
    _call: function (method, params) {
        return new Promise((resolve, reject) => {
            this.api.call(method, params, resolve, reject);
        });
    },

    /** Multi-call wrapper */
    _multiCall: function (calls) {
        return new Promise((resolve, reject) => {
            this.api.multiCall(calls, resolve, reject);
        });
    },

    /** Yield the main thread to keep UI responsive */
    _yield: function () {
        return new Promise(resolve => setTimeout(resolve, 0));
    },

    /** Sleep helper */
    _sleep: function (ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    },

    /**
     * Run multiCalls in sequential chunks with yielding and delays.
     */
    _runChunkedMultiCall: async function (calls) {
        let allResults = [];
        for (let i = 0; i < calls.length; i += this.MULTICALL_CHUNK_SIZE) {
            const chunk = calls.slice(i, i + this.MULTICALL_CHUNK_SIZE);
            try {
                const res = await this._multiCall(chunk);
                allResults = allResults.concat(res);
            } catch (err) {
                console.warn(`MultiCall chunk [${i}..] failed:`, err);
                // Fill with nulls to maintain array alignment
                allResults = allResults.concat(new Array(chunk.length).fill(null));
            }

            if (i + this.MULTICALL_CHUNK_SIZE < calls.length) {
                await this._sleep(this.MULTICALL_DELAY_MS);
            }
            await this._yield();
        }
        return allResults;
    },

    /** Auto bucket size for trend chart */
    _getAutoBucketSize: function (fromDate, toDate) {
        const days = (toDate - fromDate) / (1000 * 60 * 60 * 24);
        if (days <= 14) return 'daily';
        if (days <= 90) return 'weekly';
        return 'monthly';
    },

    /** Bucket key for grouping */
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

    /** Build labels for all buckets in range */
    _buildBucketLabels: function (fromDate, toDate, bucketSize) {
        const labels = [];
        const seen = new Set();
        let curr = new Date(fromDate);
        curr.setHours(0, 0, 0, 0);

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
     * Sorted paging for ExceptionEvents.
     * Uses ascending activeFrom sort to ensure the date-advancing window is 100% reliable.
     */
    _streamExceptionEventsAgg: async function (ruleId, fromDate, toDate, onPage) {
        let currentFromDate = new Date(fromDate);
        let guard = 0;

        while (currentFromDate < toDate) {
            guard++;
            if (guard > 10000) break; // Defensive exit

            if (!currentFromDate || isNaN(currentFromDate) || currentFromDate >= toDate) break;

            let results;
            try {
                console.log(`Geotab API: Fetching rule ${ruleId} from ${currentFromDate.toISOString()}...`);
                results = await this._call("Get", {
                    typeName: "ExceptionEvent",
                    search: {
                        fromDate: currentFromDate.toISOString(),
                        toDate: toDate.toISOString(),
                        ruleSearch: { id: ruleId }
                    },
                    sort: { sortBy: "activeFrom", sortDirection: "asc" },
                    resultsLimit: this.EXCEPTION_PAGE_SIZE
                });
            } catch (err) {
                console.warn(`Geotab API: Exception fetch for rule ${ruleId} failed/skipped:`, err.message || err);
                break;
            }

            if (!results || results.length === 0) break;

            onPage(results);

            if (results.length < this.EXCEPTION_PAGE_SIZE) break;

            const last = results[results.length - 1];
            const lastTime = new Date(last.activeFrom || last.activeTo);
            const nextFrom = new Date(lastTime.getTime() + 1);

            if (nextFrom <= currentFromDate) break; // Infinite loop protection
            currentFromDate = nextFrom;

            await this._yield();
        }
    },

    /**
     * Fetch all core fleet info (Devices + Groups) in one go for consistency.
     */
    getFleetInfo: async function () {
        try {
            console.log("Geotab API: Fetching fleet info (Devices + Groups)...");
            const results = await this._multiCall([
                ["Get", { typeName: "Device" }],
                ["Get", { typeName: "Group" }]
            ]);

            const allDevices = results[0] || [];
            const rawGroups = results[1] || [];
            const now = new Date();

            // 1. Filter active devices
            const devices = allDevices.filter(d => {
                if (!d) return false;
                if (!d.activeTo) return true;
                return new Date(d.activeTo) > now;
            });

            // 2. Build group maps
            const groupNameMap = {};
            rawGroups.forEach(g => { groupNameMap[g.id] = g.name; });

            const deviceGroupMap = {};
            devices.forEach(d => {
                const names = [];
                const idKey = d.id + "_ids";
                deviceGroupMap[idKey] = [];
                (d.groups || []).forEach(g => {
                    if (groupNameMap[g.id]) names.push(groupNameMap[g.id]);
                    deviceGroupMap[idKey].push(g.id);
                });
                deviceGroupMap[d.id] = names.join(", ");
            });

            console.log(`Geotab API: Fleet info loaded. ${devices.length} active devices across ${rawGroups.length} groups.`);
            return { devices, deviceGroupsMap: deviceGroupMap, rawGroups };
        } catch (e) {
            console.error("Geotab API: Fatal error fetching fleet info:", e);
            return { devices: [], deviceGroupsMap: {}, rawGroups: [] };
        }
    },

    /** Idling duration + trend */
    getIdleDurationPerDevice: async function (devices, fromDate, toDate) {
        const bucketSize = this._getAutoBucketSize(fromDate, toDate);
        const bucketLabels = this._buildBucketLabels(fromDate, toDate, bucketSize);
        const bucketHours = Object.fromEntries(bucketLabels.map(l => [l, 0]));

        const deviceIdling = {};
        let totalHours = 0;

        await this._streamExceptionEventsAgg(this.IDLE_RULE_ID, fromDate, toDate, (events) => {
            for (const event of events) {
                const devId = event.device && event.device.id;
                if (!devId) continue;

                const start = new Date(event.activeFrom);
                const end = new Date(event.activeTo || event.activeFrom);
                const hours = (end - start) / 3600000;

                deviceIdling[devId] = (deviceIdling[devId] || 0) + hours;
                totalHours += hours;

                const key = this._getBucketKey(start, bucketSize);
                if (key in bucketHours) bucketHours[key] += hours;
            }
        });

        const trendData = bucketLabels.map(l => ({ label: l, value: bucketHours[l] || 0 }));
        return { totalHours, deviceIdling, trendData, bucketSize };
    },

    /** Harsh driving + trend */
    getHarshDrivingPerDevice: async function (devices, fromDate, toDate) {
        const bucketSize = this._getAutoBucketSize(fromDate, toDate);
        const bucketLabels = this._buildBucketLabels(fromDate, toDate, bucketSize);
        const bucketCounts = Object.fromEntries(bucketLabels.map(l => [l, 0]));

        const deviceHarshCounts = {};
        let totalCount = 0;

        const ruleIds = ["RuleJackrabbitStartsId", "RuleHarshBrakingId", "RuleHarshCorneringId"];

        for (const ruleId of ruleIds) {
            await this._streamExceptionEventsAgg(ruleId, fromDate, toDate, (events) => {
                for (const event of events) {
                    const devId = event.device && event.device.id;
                    if (!devId) continue;

                    deviceHarshCounts[devId] = (deviceHarshCounts[devId] || 0) + 1;
                    totalCount++;

                    const key = this._getBucketKey(event.activeFrom, bucketSize);
                    if (key in bucketCounts) bucketCounts[key]++;
                }
            });
            await this._sleep(100);
        }

        const trendData = bucketLabels.map(l => ({ label: l, value: bucketCounts[l] || 0 }));
        return { totalCount, deviceHarshCounts, trendData, bucketSize };
    },

    /** Utilization via odometer start/end StatusData delta */
    getUtilizationPerDevice: async function (devices, fromDate, toDate) {
        if (!devices || devices.length === 0) return { underutilizedCount: 0, deviceUtilization: {} };

        // Odometer is in meters. 2000m = 2km threshold.
        const MIN_DISTANCE_METERS = 2000;

        const startCalls = devices.map(d => ["Get", {
            typeName: "StatusData",
            search: {
                deviceSearch: { id: d.id },
                diagnosticSearch: { id: this.ODO_DIAGNOSTIC_ID },
                fromDate: fromDate.toISOString(),
                toDate: toDate.toISOString()
            },
            sort: { sortBy: "dateTime", sortDirection: "asc" },
            resultsLimit: 1
        }]);

        const endCalls = devices.map(d => ["Get", {
            typeName: "StatusData",
            search: {
                deviceSearch: { id: d.id },
                diagnosticSearch: { id: this.ODO_DIAGNOSTIC_ID },
                fromDate: fromDate.toISOString(),
                toDate: toDate.toISOString()
            },
            sort: { sortBy: "dateTime", sortDirection: "desc" },
            resultsLimit: 1
        }]);

        const startResults = await this._runChunkedMultiCall(startCalls);
        await this._yield(); // Breath between large start/end pulls
        const endResults = await this._runChunkedMultiCall(endCalls);

        const deviceUtilization = {};
        let underutilizedCount = 0;

        for (let i = 0; i < devices.length; i++) {
            const d = devices[i];
            const startOdo = (startResults[i] && startResults[i].length) ? startResults[i][0].data : null;
            const endOdo = (endResults[i] && endResults[i].length) ? endResults[i][0].data : null;

            let isUnderutilized = true;
            if (startOdo !== null && endOdo !== null) {
                isUnderutilized = Math.abs(endOdo - startOdo) < MIN_DISTANCE_METERS;
            }

            deviceUtilization[d.id] = isUnderutilized;
            if (isUnderutilized) underutilizedCount++;
        }

        return { underutilizedCount, deviceUtilization };
    }
};
