// src/rendering/tooltip.js
// Tooltip HTML generation for packet visualization

import { classifyFlags } from '../tcp/flags.js';
import { formatBytes, formatTimestamp, normalizeProtocolValue } from '../utils/formatters.js';
import { PROTOCOL_MAP } from '../config/constants.js';

/**
 * Create tooltip HTML for packet or bin data.
 * @param {Object} data - Packet or binned data
 * @returns {string} HTML string for tooltip
 */
export function createTooltipHTML(data) {
    function extractProtocol(p) {
        if (!p) return 'TCP';
        const raw = p.protocol ?? p.ip_proto ?? p.ipProtocol ?? p.proto ?? p.ipProtocolNumber;
        return normalizeProtocolValue(raw, PROTOCOL_MAP);
    }

    if (data.binned && data.count > 1) {
        // Binned data tooltip
        const { utcTime } = formatTimestamp(data.timestamp);
        let tooltipContent = `<b>${data.flagType} (Binned)</b><br>`;
        tooltipContent += `Count: ${data.count} packets<br>`;

        // Show source IP (row) and destination summary
        const srcPort = data.src_port ?? data.srcPort;
        const dstPort = data.dst_port ?? data.dstPort;
        if (srcPort !== undefined && dstPort !== undefined) {
            tooltipContent += `From: ${data.src_ip}:${srcPort}<br>To: ${data.dst_ip}:${dstPort}<br>`;
        } else {
            tooltipContent += `From: ${data.src_ip}<br>To: ${data.dst_ip}<br>`;
        }

        if (data.originalPackets && data.originalPackets.length) {
            const protocols = Array.from(new Set(data.originalPackets.map(extractProtocol)));
            tooltipContent += `Protocol: ${protocols.join(', ')}<br>`;
        } else {
            tooltipContent += `Protocol: ${extractProtocol(data)}<br>`;
        }

        tooltipContent += `Time Bin: ${utcTime}<br>`;
        tooltipContent += `Total Bytes: ${formatBytes(data.totalBytes || data.total_bytes || 0)}`;

        // Show range of sequence numbers if available
        if (data.originalPackets && data.originalPackets.length > 0) {
            const seqNums = data.originalPackets
                .map(p => p.seq_num)
                .filter(s => s !== undefined && s !== null);
            if (seqNums.length > 0) {
                const minSeq = Math.min(...seqNums);
                const maxSeq = Math.max(...seqNums);
                tooltipContent += `<br>Seq Range: ${minSeq} - ${maxSeq}`;
            }
        }

        return tooltipContent;
    } else {
        // Single packet tooltip
        const packet = data.originalPackets ? data.originalPackets[0] : data;
        const { utcTime } = formatTimestamp(packet.timestamp);
        let tooltipContent = `<b>${classifyFlags(packet.flags)}</b><br>`;

        // Show IP:port format
        const srcPort = packet.src_port ?? packet.srcPort;
        const dstPort = packet.dst_port ?? packet.dstPort;
        if (srcPort !== undefined && dstPort !== undefined) {
            tooltipContent += `From: ${packet.src_ip}:${srcPort}<br>To: ${packet.dst_ip}:${dstPort}<br>`;
        } else {
            tooltipContent += `From: ${packet.src_ip}<br>To: ${packet.dst_ip}<br>`;
        }

        tooltipContent += `Protocol: ${extractProtocol(packet)}<br>`;
        tooltipContent += `Time: ${utcTime}`;

        // Show packet length/size if available
        if (packet.length !== undefined) {
            tooltipContent += `<br>Size: ${formatBytes(packet.length)}`;
        }

        if (packet.seq_num !== undefined && packet.seq_num !== null) {
            tooltipContent += `<br>Seq: ${packet.seq_num}`;
        }
        if (packet.ack_num !== undefined && packet.ack_num !== null) {
            tooltipContent += `<br>Ack: ${packet.ack_num}`;
        }

        return tooltipContent;
    }
}

/**
 * Show tooltip at specified position.
 * @param {Object} d3 - D3 library reference
 * @param {string} html - Tooltip HTML content
 * @param {number} x - Page X position
 * @param {number} y - Page Y position
 * @param {number} offsetX - X offset (default 40)
 * @param {number} offsetY - Y offset (default -40)
 */
export function showTooltip(d3, html, x, y, offsetX = 40, offsetY = -40) {
    d3.select('#tooltip')
        .style('display', 'block')
        .html(html)
        .style('left', `${x + offsetX}px`)
        .style('top', `${y + offsetY}px`);
}

/**
 * Hide tooltip.
 * @param {Object} d3 - D3 library reference
 */
export function hideTooltip(d3) {
    d3.select('#tooltip').style('display', 'none');
}
