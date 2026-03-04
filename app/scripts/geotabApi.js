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
     * Get underutilized vehicles mapping using Sub-periods (Daily, Weekly, Monthly)
     * Grabs Odometer point at every boundary date to calculate movement over that specific period.
     */
    getUtilizationPerDevice: async function (devices, fromDate, toDate, subPeriod) {
        try {
            // Helper to chunk multiCalls to avoid API limits
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

            // Generate boundary dates
            const boundaryDates = [];
            let curr = new Date(fromDate);
            // Ensure we don't accidentally infinite loop on weird timezone issues
            let failsafeCount = 0;

            while (curr < toDate && failsafeCount < 1000) {
                boundaryDates.push(new Date(curr));
                if (subPeriod === 'Daily') curr.setDate(curr.getDate() + 1);
                else if (subPeriod === 'Weekly') curr.setDate(curr.getDate() + 7);
                else curr.setMonth(curr.getMonth() + 1);
                failsafeCount++;
            }
            // Always push the exact end date to capture the final segment
            boundaryDates.push(new Date(toDate));

            // Create a call matrix: device -> [boundary_0... boundary_N]
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

            // Execute all calls in parallel via chunking
            const allOdoResults = await runChunkedMultiCall(calls);

            const deviceUtilizationSubperiods = {}; // { deviceId: stationaryPeriodsCount }
            let totalStationaryPeriods = 0;

            let resultIndex = 0;
            const segmentsPerDevice = boundaryDates.length;

            devices.forEach(d => {
                let stationaryCount = 0;

                // Get this device's segment results
                const deviceResults = allOdoResults.slice(resultIndex, resultIndex + segmentsPerDevice);

                // Walk through periods: compare i and i+1
                for (let i = 0; i < deviceResults.length - 1; i++) {
                    const startOdoData = deviceResults[i] && deviceResults[i].length > 0 ? deviceResults[i][0].data : null;
                    const endOdoData = deviceResults[i + 1] && deviceResults[i + 1].length > 0 ? deviceResults[i + 1][0].data : null;

                    if (startOdoData !== null && endOdoData !== null) {
                        const diffMeters = Math.abs(endOdoData - startOdoData);
                        if (diffMeters < 2000) {
                            stationaryCount++; // Did not move >= 2km in this sub-period
                        }
                    } else {
                        // If missing data entirely from Geotab historical data, assume stationary/offline for this chunk
                        stationaryCount++;
                    }
                }

                deviceUtilizationSubperiods[d.id] = stationaryCount;
                totalStationaryPeriods += stationaryCount;

                resultIndex += segmentsPerDevice;
            });

            return { totalStationaryPeriods, deviceUtilizationSubperiods };
        } catch (e) {
            console.error("Error fetching utilization data via Odometer points", e);
            throw e;
        }
    }
};
