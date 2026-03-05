/**
 * Service to handle data fetching from Geotab API
 */
window.GeotabApiService = function (api) {
    this.api = api;
};

window.GeotabApiService.prototype = {
    /**
     * Helper to perform API multi-calls
     */
    _multiCall: function (calls) {
        return new Promise((resolve, reject) => {
            this.api.multiCall(calls, function (results) {
                resolve(results);
            }, function (err) {
                reject(err);
            });
        });
    },

    /**
     * Helper to run chunked multiCalls to avoid Geotab limits (max 10,000, safe 2,000)
     */
    _runChunkedMultiCall: async function (calls, chunkSize = 500) {
        const chunks = [];
        for (let i = 0; i < calls.length; i += chunkSize) {
            chunks.push(calls.slice(i, i + chunkSize));
        }
        let allResults = [];
        for (const chunk of chunks) {
            const res = await this._multiCall(chunk);
            allResults = allResults.concat(res);
        }
        return allResults;
    },

    /**
     * Helper to perform single API call
     */
    _call: function (method, params) {
        return new Promise((resolve, reject) => {
            this.api.call(method, params, function (result) {
                resolve(result);
            }, function (err) {
                reject(err);
            });
        });
    },

    /**
     * Helper: Build an array of {from, to, label} period windows based on sub-period granularity
     */
    _buildPeriods: function (fromDate, toDate, subPeriod) {
        const periods = [];
        let curr = new Date(fromDate);
        let failsafe = 0;

        while (curr < toDate && failsafe < 1000) {
            const periodStart = new Date(curr);
            let periodEnd;

            if (subPeriod === 'Daily') {
                periodEnd = new Date(curr);
                periodEnd.setDate(periodEnd.getDate() + 1);
            } else if (subPeriod === 'Weekly') {
                periodEnd = new Date(curr);
                periodEnd.setDate(periodEnd.getDate() + 7);
            } else {
                // Monthly
                periodEnd = new Date(curr);
                periodEnd.setMonth(periodEnd.getMonth() + 1);
            }

            if (periodEnd > toDate) periodEnd = new Date(toDate);

            // Build a readable label
            let label;
            if (subPeriod === 'Daily') {
                label = periodStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            } else if (subPeriod === 'Weekly') {
                label = `W/${periodStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
            } else {
                label = periodStart.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
            }

            periods.push({ from: periodStart, to: periodEnd, label });
            curr = new Date(periodEnd);
            failsafe++;
        }

        return periods;
    },

    /**
     * Get active devices, filtering out untracked (historic/archived/terminated) devices.
     */
    getDevices: async function () {
        try {
            const devices = await this._call("Get", {
                typeName: "Device"
            });

            // Only keep devices actively tracked (their activeTo date is in the future)
            const now = new Date();
            return devices.filter(d => d.activeTo && new Date(d.activeTo) > now);
        } catch (e) {
            console.error("Error fetching devices", e);
            throw e;
        }
    },

    /**
     * Get Device Groups map and raw groups
     */
    getDeviceGroupsMap: async function () {
        try {
            const calls = [
                ["Get", { typeName: "Device" }],
                ["Get", { typeName: "Group" }]
            ];

            const results = await this._multiCall(calls);
            const devices = results[0] || [];
            const groups = results[1] || [];

            const groupMap = {};
            groups.forEach(g => { groupMap[g.id] = g.name; });

            const deviceGroupMap = {};
            devices.forEach(d => {
                const deviceGroups = [];
                if (d.groups) {
                    d.groups.forEach(g => {
                        if (groupMap[g.id]) deviceGroups.push(groupMap[g.id]);
                        // Also store raw IDs for group filtering
                        if (!deviceGroupMap[d.id + '_ids']) deviceGroupMap[d.id + '_ids'] = [];
                        deviceGroupMap[d.id + '_ids'].push(g.id);
                    });
                }
                deviceGroupMap[d.id] = deviceGroups.join(", ");
            });

            return {
                map: deviceGroupMap,
                rawGroups: groups
            };
        } catch (e) {
            console.error("Error fetching groups", e);
            return { map: {}, rawGroups: [] };
        }
    },

    /**
     * Get Idle duration per device and per sub-period (for trend line chart).
     * Fetches one time-window at a time to prevent OverLimit errors.
     */
    getIdleDurationPerDevice: async function (devices, fromDate, toDate, subPeriod) {
        try {
            const periods = this._buildPeriods(fromDate, toDate, subPeriod);
            const deviceIdling = {}; // { deviceId: totalHours }
            let totalHours = 0;
            // Trend data: [{label, totalIdleHours}]
            const trendData = [];

            for (const period of periods) {
                let periodHours = 0;

                try {
                    // Fetch ONE window at a time — safe regardless of fleet size
                    const results = await this._call("Get", {
                        typeName: "ExceptionEvent",
                        search: {
                            fromDate: period.from.toISOString(),
                            toDate: period.to.toISOString(),
                            ruleSearch: { id: "aU_66pnHj8EeIWFcP8CcX7Q" }
                        }
                    });

                    if (results && Array.isArray(results)) {
                        results.forEach(event => {
                            if (!event.device || !event.device.id) return;
                            const devId = event.device.id;
                            const start = new Date(event.activeFrom);
                            const end = new Date(event.activeTo);
                            const hours = (end.getTime() - start.getTime()) / 3600000;

                            if (!deviceIdling[devId]) deviceIdling[devId] = 0;
                            deviceIdling[devId] += hours;
                            totalHours += hours;
                            periodHours += hours;
                        });
                    }
                } catch (err) {
                    console.warn(`Idle data fetch failed for period ${period.label}. Skipping.`, err);
                }

                trendData.push({ label: period.label, value: periodHours });
            }

            return { totalHours, deviceIdling, trendData };
        } catch (e) {
            console.error("Error fetching idle data", e);
            throw e;
        }
    },

    /**
     * Get Harsh Driving event counts per device and per sub-period (for trend line chart).
     */
    getHarshDrivingPerDevice: async function (devices, fromDate, toDate, subPeriod) {
        const deviceHarshCounts = {}; // { deviceId: count }
        let totalCount = 0;
        const trendData = []; // [{label, value}]

        const ruleIds = ["RuleJackrabbitStartsId", "RuleHarshBrakingId", "RuleHarshCorneringId"];
        const periods = this._buildPeriods(fromDate, toDate, subPeriod);

        for (const period of periods) {
            let periodCount = 0;

            for (const ruleId of ruleIds) {
                try {
                    const results = await this._call("Get", {
                        typeName: "ExceptionEvent",
                        search: {
                            fromDate: period.from.toISOString(),
                            toDate: period.to.toISOString(),
                            ruleSearch: { id: ruleId }
                        }
                    });

                    if (results && Array.isArray(results)) {
                        results.forEach(event => {
                            if (!event.device || !event.device.id) return;
                            const devId = event.device.id;
                            if (!deviceHarshCounts[devId]) deviceHarshCounts[devId] = 0;
                            deviceHarshCounts[devId]++;
                            totalCount++;
                            periodCount++;
                        });
                    }
                } catch (err) {
                    console.warn(`Harsh driving data fetch failed for rule: ${ruleId} on period ${period.label}. Skipping.`, err);
                }
            }

            trendData.push({ label: period.label, value: periodCount });
        }

        return { totalCount, deviceHarshCounts, trendData };
    },

    /**
     * Get underutilized vehicles mapping using Sub-periods.
     * Grabs a single fleet-wide Status Data check at each boundary date.
     */
    getUtilizationPerDevice: async function (devices, fromDate, toDate, subPeriod) {
        try {
            const periods = this._buildPeriods(fromDate, toDate, subPeriod);

            // Build boundary dates (start of each period + final end date)
            const boundaryDates = [periods[0].from, ...periods.map(p => p.to)];

            // Create a call for each device x boundary
            const calls = [];
            devices.forEach(d => {
                boundaryDates.forEach(date => {
                    calls.push(["Get", {
                        typeName: "StatusData",
                        search: {
                            deviceSearch: { id: d.id },
                            diagnosticSearch: { id: "DiagnosticOdometerId" },
                            fromDate: date.toISOString()
                        },
                        resultsLimit: 1
                    }]);
                });
            });

            const allOdoResults = await this._runChunkedMultiCall(calls);

            const deviceUtilizationSubperiods = {}; // { deviceId: stationaryPeriodsCount }
            let totalStationaryPeriods = 0;
            const segmentsPerDevice = boundaryDates.length;

            // Trend data: per sub-period, count of stationary vehicles
            const trendData = periods.map(p => ({ label: p.label, value: 0 }));

            let resultIndex = 0;

            devices.forEach(d => {
                let stationaryCount = 0;
                const deviceResults = allOdoResults.slice(resultIndex, resultIndex + segmentsPerDevice);

                for (let i = 0; i < deviceResults.length - 1; i++) {
                    const startOdo = deviceResults[i] && deviceResults[i].length > 0 ? deviceResults[i][0].data : null;
                    const endOdo = deviceResults[i + 1] && deviceResults[i + 1].length > 0 ? deviceResults[i + 1][0].data : null;

                    let isStationary = false;
                    if (startOdo !== null && endOdo !== null) {
                        isStationary = Math.abs(endOdo - startOdo) < 2000;
                    } else {
                        isStationary = true; // Missing data = assume stationary/offline
                    }

                    if (isStationary) {
                        stationaryCount++;
                        if (trendData[i]) trendData[i].value++;
                    }
                }

                deviceUtilizationSubperiods[d.id] = stationaryCount;
                totalStationaryPeriods += stationaryCount;
                resultIndex += segmentsPerDevice;
            });

            return { totalStationaryPeriods, deviceUtilizationSubperiods, trendData };
        } catch (e) {
            console.error("Error fetching utilization data via Odometer points", e);
            throw e;
        }
    }
};
