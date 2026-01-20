// src/groundTruth/groundTruth.js
// Ground truth event data handling

import { utcToEpochMicroseconds, epochMicrosecondsToUTC } from '../utils/formatters.js';

/**
 * Load ground truth data from CSV file.
 * @param {string} url - URL to CSV file
 * @returns {Promise<Array>} Ground truth events
 */
export async function loadGroundTruthData(url = 'GroundTruth_UTC_naive.csv') {
    try {
        const response = await fetch(url);
        const csvText = await response.text();
        const lines = csvText.split('\n');

        const groundTruthData = [];

        for (let i = 1; i < lines.length; i++) {
            if (lines[i].trim()) {
                const values = lines[i].split(',');
                if (values.length >= 8) {
                    groundTruthData.push({
                        eventType: values[0],
                        c2sId: values[1],
                        source: values[2],
                        sourcePorts: values[3],
                        destination: values[4],
                        destinationPorts: values[5],
                        startTime: values[6],
                        stopTime: values[7],
                        startTimeMicroseconds: utcToEpochMicroseconds(values[6]),
                        stopTimeMicroseconds: utcToEpochMicroseconds(values[7])
                    });
                }
            }
        }

        console.log(`Loaded ${groundTruthData.length} ground truth events`);
        return groundTruthData;
    } catch (error) {
        console.warn('Could not load ground truth data:', error);
        return [];
    }
}

/**
 * Filter ground truth events by selected IPs.
 * @param {Array} groundTruthData - All events
 * @param {Array} selectedIPs - Selected IP addresses
 * @returns {Array} Filtered events
 */
export function filterGroundTruthByIPs(groundTruthData, selectedIPs) {
    if (!groundTruthData || groundTruthData.length === 0 || selectedIPs.length < 2) {
        return [];
    }

    return groundTruthData.filter(event => {
        return selectedIPs.includes(event.source) && selectedIPs.includes(event.destination);
    });
}

/**
 * Prepare ground truth box data for visualization.
 * @param {Array} events - Filtered events
 * @param {Object} options - {xScale, findIPPosition, pairs, ipPositions, eventColors}
 * @returns {Array} Box data for D3
 */
export function prepareGroundTruthBoxData(events, options) {
    const { xScale, findIPPosition, pairs, ipPositions, eventColors } = options;

    const boxData = [];

    events.forEach(event => {
        const sourceY = findIPPosition(event.source, event.source, event.destination, pairs, ipPositions);
        const destY = findIPPosition(event.destination, event.source, event.destination, pairs, ipPositions);

        if (sourceY === 0 || destY === 0) return;

        // Add 59 seconds to stop time for all events
        const adjustedStopMicroseconds = event.stopTimeMicroseconds + 59 * 1_000_000;

        const startX = xScale(event.startTimeMicroseconds);
        const endX = xScale(adjustedStopMicroseconds);
        const width = Math.max(1, endX - startX);
        const boxHeight = 20;

        // Source box
        boxData.push({
            event,
            ip: event.source,
            x: startX,
            y: sourceY - boxHeight / 2,
            width,
            height: boxHeight,
            color: eventColors[event.eventType] || '#666',
            isSource: true,
            adjustedStartMicroseconds: event.startTimeMicroseconds,
            adjustedStopMicroseconds,
            wasExpanded: true
        });

        // Destination box
        boxData.push({
            event,
            ip: event.destination,
            x: startX,
            y: destY - boxHeight / 2,
            width,
            height: boxHeight,
            color: eventColors[event.eventType] || '#666',
            isSource: false,
            adjustedStartMicroseconds: event.startTimeMicroseconds,
            adjustedStopMicroseconds,
            wasExpanded: true
        });
    });

    return boxData;
}

/**
 * Update ground truth statistics display.
 * @param {Array} groundTruthData - All events
 * @param {Array} selectedIPs - Selected IPs
 * @param {Object} eventColors - Event color map
 * @returns {Object} Stats object {html, hasMatches}
 */
export function calculateGroundTruthStats(groundTruthData, selectedIPs, eventColors) {
    if (!groundTruthData || groundTruthData.length === 0) {
        return { html: 'Ground truth data not loaded', hasMatches: false };
    }

    if (selectedIPs.length < 2) {
        return {
            html: `Loaded ${groundTruthData.length} total events<br>Select 2+ IPs to view matching events`,
            hasMatches: false
        };
    }

    const matchingEvents = filterGroundTruthByIPs(groundTruthData, selectedIPs);

    if (matchingEvents.length === 0) {
        return {
            html: `No ground truth events found for selected IPs<br>Total events: ${groundTruthData.length}`,
            hasMatches: false
        };
    }

    // Group events by type
    const eventTypeCounts = {};
    matchingEvents.forEach(event => {
        eventTypeCounts[event.eventType] = (eventTypeCounts[event.eventType] || 0) + 1;
    });

    let statsHTML = `<strong>${matchingEvents.length} matching events found</strong><br>`;
    Object.entries(eventTypeCounts).forEach(([type, count]) => {
        const color = eventColors[type] || '#666';
        statsHTML += `<span style="color: ${color}; font-weight: bold;">${type}: ${count}</span><br>`;
    });

    return { html: statsHTML, hasMatches: true };
}