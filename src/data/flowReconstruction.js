// src/data/flowReconstruction.js
// TCP flow reconstruction from packet data

import { makeConnectionKey } from '../utils/formatters.js';
import { LOG } from '../utils/formatters.js';

/**
 * Reconstruct flows from CSV packets asynchronously with progress.
 * @param {Array} packets - All packets
 * @param {Function} onProgress - Progress callback (processed, total) => void
 * @param {number} batchSize - Packets per batch
 * @returns {Promise<Array>} Reconstructed flows
 */
export async function reconstructFlowsFromCSVAsync(packets, onProgress, batchSize = 5000) {
    const flowMap = new Map();
    const total = Array.isArray(packets) ? packets.length : 0;
    let processed = 0;

    for (let start = 0; start < total; start += batchSize) {
        const end = Math.min(total, start + batchSize);

        for (let i = start; i < end; i++) {
            const packet = packets[i];
            const flowId = packet.flow_id;
            if (!flowId || flowId === '') continue;

            if (!flowMap.has(flowId)) {
                flowMap.set(flowId, {
                    id: flowId,
                    key: makeConnectionKey(packet.src_ip, packet.src_port, packet.dst_ip, packet.dst_port),
                    initiator: packet.src_ip,
                    responder: packet.dst_ip,
                    initiatorPort: parseInt(packet.src_port) || 0,
                    responderPort: parseInt(packet.dst_port) || 0,
                    state: packet.flow_state || 'unknown',
                    establishmentComplete: packet.establishment_complete === true,
                    dataTransferStarted: packet.data_transfer_started === true,
                    closingStarted: packet.closing_started === true,
                    closeType: packet.flow_close_type || null,
                    startTime: parseInt(packet.flow_start_time) || packet.timestamp,
                    endTime: parseInt(packet.flow_end_time) || packet.timestamp,
                    totalPackets: parseInt(packet.flow_total_packets) || 1,
                    totalBytes: parseInt(packet.flow_total_bytes) || 0,
                    invalidReason: packet.flow_invalid_reason || null,
                    phases: { establishment: [], dataTransfer: [], closing: [] }
                });
            } else {
                const flow = flowMap.get(flowId);
                flow.startTime = Math.min(flow.startTime, packet.timestamp);
                flow.endTime = Math.max(flow.endTime, packet.timestamp);
                if (packet.flow_total_packets) {
                    const newPackets = parseInt(packet.flow_total_packets);
                    if (!isNaN(newPackets)) flow.totalPackets = newPackets;
                }
                if (packet.flow_total_bytes) {
                    const newBytes = parseInt(packet.flow_total_bytes);
                    if (!isNaN(newBytes)) flow.totalBytes = newBytes;
                }
            }
        }

        processed = end;
        if (typeof onProgress === 'function') onProgress(processed, total);
        await new Promise(r => setTimeout(r, 0)); // Yield to event loop
    }

    const flows = Array.from(flowMap.values());
    LOG(`Reconstructed ${flows.length} flows from ${packets.length} packets`);
    return flows;
}

/**
 * Reconstruct flows from CSV packets (synchronous version).
 * @param {Array} packets - All packets
 * @returns {Array} Reconstructed flows
 */
export function reconstructFlowsFromCSV(packets) {
    const flowMap = new Map();
    let processedCount = 0;
    
    packets.forEach((packet, index) => {
        const flowId = packet.flow_id;
        if (!flowId || flowId === '') return;
        
        if (!flowMap.has(flowId)) {
            // Create new flow entry based on packet data
            const flowData = {
                id: flowId,
                key: makeConnectionKey(packet.src_ip, packet.src_port, packet.dst_ip, packet.dst_port),
                initiator: packet.src_ip,
                responder: packet.dst_ip,
                initiatorPort: parseInt(packet.src_port) || 0,
                responderPort: parseInt(packet.dst_port) || 0,
                state: packet.flow_state || 'unknown',
                establishmentComplete: packet.establishment_complete === true,
                dataTransferStarted: packet.data_transfer_started === true,
                closingStarted: packet.closing_started === true,
                closeType: packet.flow_close_type || null,
                startTime: parseInt(packet.flow_start_time) || packet.timestamp,
                endTime: parseInt(packet.flow_end_time) || packet.timestamp,
                totalPackets: parseInt(packet.flow_total_packets) || 1,
                totalBytes: parseInt(packet.flow_total_bytes) || 0,
                invalidReason: packet.flow_invalid_reason || null,
                phases: {
                    establishment: [],
                    dataTransfer: [],
                    closing: []
                }
            };
            
            flowMap.set(flowId, flowData);
            processedCount++;
        } else {
            // Update existing flow with any new information
            const flow = flowMap.get(flowId);
            flow.startTime = Math.min(flow.startTime, packet.timestamp);
            flow.endTime = Math.max(flow.endTime, packet.timestamp);
            if (packet.flow_total_packets) {
                const newPackets = parseInt(packet.flow_total_packets);
                if (!isNaN(newPackets)) flow.totalPackets = newPackets;
            }
            if (packet.flow_total_bytes) {
                const newBytes = parseInt(packet.flow_total_bytes);
                if (!isNaN(newBytes)) flow.totalBytes = newBytes;
            }
        }
    });
    
    const flows = Array.from(flowMap.values());
    LOG(`Reconstructed ${flows.length} flows from ${packets.length} packets`);
    return flows;
}

/**
 * Build selected flow key set for filtering.
 * @param {Array} tcpFlows - All flows
 * @param {Set} selectedFlowIds - Set of selected flow IDs (as strings)
 * @returns {Set} Set of connection keys
 */
export function buildSelectedFlowKeySet(tcpFlows, selectedFlowIds) {
    const keys = new Set();
    if (!tcpFlows || tcpFlows.length === 0 || selectedFlowIds.size === 0) return keys;

    tcpFlows.forEach(flow => {
        if (selectedFlowIds.has(String(flow.id))) {
            const key = flow.key || makeConnectionKey(
                flow.initiator, flow.initiatorPort,
                flow.responder, flow.responderPort
            );
            if (key) {
                keys.add(key);
                LOG(`Selected flow key: ${key} for flow ${flow.id}`);
            }
        }
    });

    LOG(`Built ${keys.size} selected flow keys:`, Array.from(keys));
    return keys;
}

/**
 * Verify flow-packet connection for debugging.
 * @param {Array} packets
 * @param {Array} flows
 */
export function verifyFlowPacketConnection(packets, flows) {
    LOG('=== Flow-Packet Connection Verification ===');

    const packetKeys = new Set();
    const packetKeyCount = new Map();

    packets.forEach(packet => {
        const key = makeConnectionKey(packet.src_ip, packet.src_port, packet.dst_ip, packet.dst_port);
        packetKeys.add(key);
        packetKeyCount.set(key, (packetKeyCount.get(key) || 0) + 1);
    });

    LOG(`Found ${packetKeys.size} unique packet connection keys`);

    let matchedFlows = 0;
    let unmatchedFlows = 0;

    flows.forEach(flow => {
        const flowKey = flow.key;
        if (packetKeys.has(flowKey)) {
            matchedFlows++;
            LOG(`✓ Flow ${flow.id} matches packets (${packetKeyCount.get(flowKey)} packets)`);
        } else {
            unmatchedFlows++;
            LOG(`✗ Flow ${flow.id} has no matching packets (key: ${flowKey})`);
        }
    });

    LOG(`Flow verification: ${matchedFlows} matched, ${unmatchedFlows} unmatched`);
}

/**
 * Export flow packets to CSV file.
 * @param {Object} flow - Flow object
 * @param {Array} fullData - All packet data
 * @param {Object} helpers - {classifyFlags, formatTimestamp}
 */
export function exportFlowToCSV(flow, fullData, helpers) {
    const { classifyFlags, formatTimestamp } = helpers;

    try {
        const key = flow.key || makeConnectionKey(
            flow.initiator, flow.initiatorPort,
            flow.responder, flow.responderPort
        );
        const packets = (fullData || []).filter(p => {
            if (!(p.src_ip && p.dst_ip && p.src_port && p.dst_port)) return false;
            return makeConnectionKey(p.src_ip, p.src_port, p.dst_ip, p.dst_port) === key;
        });

        if (packets.length === 0) {
            alert('No packets found for this flow.');
            return;
        }

        // Deduplicate
        const dedupMap = new Map();
        packets.forEach(p => {
            const k = [
                Math.floor(p.timestamp), p.src_ip, p.src_port, p.dst_ip, p.dst_port,
                p.flags, p.seq_num ?? '', p.ack_num ?? '', p.length ?? ''
            ].join('|');
            if (!dedupMap.has(k)) dedupMap.set(k, p);
        });
        const deduped = Array.from(dedupMap.values()).sort((a, b) => a.timestamp - b.timestamp);

        // Build CSV
        const headers = [
            'timestamp', 'utc_time', 'src_ip', 'src_port', 'dst_ip', 'dst_port',
            'flags', 'flag_type', 'seq_num', 'ack_num', 'length'
        ];
        const lines = [headers.join(',')];

        deduped.forEach(p => {
            const { utcTime } = formatTimestamp(Math.floor(p.timestamp));
            const row = [
                Math.floor(p.timestamp),
                `"${utcTime}"`,
                p.src_ip,
                p.src_port,
                p.dst_ip,
                p.dst_port,
                p.flags ?? '',
                `"${(p.flag_type || classifyFlags(p.flags) || '').toString()}"`,
                p.seq_num ?? '',
                p.ack_num ?? '',
                p.length ?? ''
            ].join(',');
            lines.push(row);
        });

        const csvContent = lines.join('\n');
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const safeInit = (flow.initiator || 'unknown').replace(/[^\w.:-]/g, '_');
        const safeResp = (flow.responder || 'unknown').replace(/[^\w.:-]/g, '_');
        a.href = url;
        a.download = `flow_${safeInit}_${flow.initiatorPort}_to_${safeResp}_${flow.responderPort}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    } catch (err) {
        console.error('Failed to export CSV:', err);
        alert('Failed to export CSV. See console for details.');
    }
}
