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
     * Get active devices without massive historical lookback to save memory,
     * filtering out untracked (historic/archived/terminated) devices.
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
                        // Also push the exact IDs so we can filter later easily
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
     * Get Idle duration structured per device
     */
    getIdleDurationPerDevice: async function (fromDate, toDate) {
        try {
            const results = await this._call("Get", {
                typeName: "ExceptionEvent",
                search: {
                    fromDate: fromDate.toISOString(),
                    toDate: toDate.toISOString(),
                    ruleSearch: { id: "aU_66pnHj8EeIWFcP8CcX7Q" } // Custom Idling Rule ID
                }
            });

            const deviceIdling = {}; // { deviceId: hours }
            let totalHours = 0;

            if (results) {
                results.forEach(event => {
                    if (!event.device || !event.device.id) return;
                    const devId = event.device.id;
                    const start = new Date(event.activeFrom);
                    const end = new Date(event.activeTo);
                    const hours = (end.getTime() - start.getTime()) / 3600000;

                    if (!deviceIdling[devId]) deviceIdling[devId] = 0;
                    deviceIdling[devId] += hours;
                    totalHours += hours;
                });
            }

            return { totalHours, deviceIdling };
        } catch (e) {
            console.error("Error fetching idle data", e);
            throw e;
        }
    },

    /**
     * Get Harsh Driving event counts per device
     * Note: We fetch each rule separately because some databases might not have 
     * one of these rules enabled, which would cause a multiCall to fail with a 400 error.
     */
    getHarshDrivingPerDevice: async function (fromDate, toDate) {
        const deviceHarshCounts = {}; // { deviceId: count }
        let totalCount = 0;

        const ruleIds = ["RuleJackrabbitStartsId", "RuleHarshBrakingId", "RuleHarshCorneringId"];

        // Fetch each rule sequentially to prevent one missing rule from taking down the others
        for (const ruleId of ruleIds) {
            try {
                const results = await this._call("Get", {
                    typeName: "ExceptionEvent",
                    search: {
                        fromDate: fromDate.toISOString(),
                        toDate: toDate.toISOString(),
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
                    });
                }
            } catch (err) {
                // If a specific rule doesn't exist (400 error) or fails, just log and continue to the next one.
                console.warn(`Harsh driving data fetch failed for rule: ${ruleId}. Skipping.`, err);
            }
        }

        return { totalCount, deviceHarshCounts };
    },

    /**
     * Get underutilized vehicles mapping
     * Optimized: Just look for StatusData instead of gigantic Trip lists.
     * Grabs Odometer point at start of period and end of period to calculate difference.
     */
    getUtilizationPerDevice: async function (devices, fromDate, toDate) {
        try {
            // Helper to chunk multiCalls to avoid API limits (Geotab limit is usually 10,000, we use 2,000 for safety)
            const chunkArray = (array, size) => {
                const results = [];
                for (let i = 0; i < array.length; i += size) {
                    results.push(array.slice(i, i + size));
                }
                return results;
            };

            const runChunkedMultiCall = async (calls) => {
                const chunks = chunkArray(calls, 2000);
                let allResults = [];
                for (const chunk of chunks) {
                    const res = await this._multiCall(chunk);
                    allResults = allResults.concat(res);
                }
                return allResults;
            };

            const fromCalls = devices.map(d => ["Get", {
                typeName: "StatusData",
                search: {
                    deviceSearch: { id: d.id },
                    diagnosticSearch: { id: "DiagnosticOdometerId" },
                    fromDate: fromDate.toISOString()
                },
                resultsLimit: 1
            }]);

            const toCalls = devices.map(d => ["Get", {
                typeName: "StatusData",
                search: {
                    deviceSearch: { id: d.id },
                    diagnosticSearch: { id: "DiagnosticOdometerId" },
                    fromDate: toDate.toISOString() // First record after End Date
                },
                resultsLimit: 1
            }]);

            // Execute in parallel
            const [fromOdoResults, toOdoResults] = await Promise.all([
                runChunkedMultiCall(fromCalls),
                runChunkedMultiCall(toCalls)
            ]);

            const deviceUtilization = {}; // { deviceId: isUnderutilized (boolean) }
            let underutilizedCount = 0;

            devices.forEach((d, index) => {
                // Extract odometer values (in meters)
                const fromOdoData = fromOdoResults[index] && fromOdoResults[index].length > 0 ? fromOdoResults[index][0].data : null;
                const toOdoData = toOdoResults[index] && toOdoResults[index].length > 0 ? toOdoResults[index][0].data : null;

                let isUnderutilized = false;

                if (fromOdoData !== null && toOdoData !== null) {
                    // Calculate distance traveled in period
                    const diffMeters = Math.abs(toOdoData - fromOdoData);

                    // If difference is less than 2000 meters (2km), we consider it stationary (accounts for minor GPS drift)
                    if (diffMeters < 2000) {
                        isUnderutilized = true;
                    }
                } else {
                    // If either point is missing entirely from Geotab historical data, assume stationary/offline
                    isUnderutilized = true;
                }

                deviceUtilization[d.id] = isUnderutilized;
                if (isUnderutilized) underutilizedCount++;
            });

            return { underutilizedCount, deviceUtilization };
        } catch (e) {
            console.error("Error fetching utilization data via Odometer points", e);
            throw e;
        }
    }
};
