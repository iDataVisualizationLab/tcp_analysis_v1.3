// src/utils/formatters.js
// Formatting utilities for bar diagram

import { DEBUG } from '../config/constants.js';

/**
 * Unified debug logger.
 * @param {...any} args
 */
export function LOG(...args) {
    if (DEBUG) console.log(...args);
}

/**
 * Format bytes to human readable string.
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
    if (bytes === null || bytes === undefined || isNaN(bytes) || bytes < 0) return '0 B';
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    const index = Math.min(i, sizes.length - 1);
    return parseFloat((bytes / Math.pow(k, index)).toFixed(1)) + ' ' + sizes[index];
}

/**
 * Format timestamp to UTC and seconds.
 * @param {number} timestamp - Microseconds
 * @returns {{utcTime: string, timestampSec: string}}
 */
export function formatTimestamp(timestamp) {
    const timestampInt = Math.floor(timestamp);
    const timestampSec = (timestampInt / 1000000).toFixed(6);
    const date = new Date(timestampInt / 1000);
    const utcTime = date.toISOString().replace('T', ' ').replace('Z', ' UTC');
    return { utcTime, timestampSec };
}

/**
 * Format duration from microseconds.
 * @param {number} us - Microseconds
 * @returns {string}
 */
export function formatDuration(us) {
    const s = us / 1_000_000;
    if (s < 0.001) return `${(s * 1000 * 1000).toFixed(0)} μs`;
    if (s < 1) return `${(s * 1000).toFixed(0)} ms`;
    if (s < 60) return `${s.toFixed(3)} s`;
    const m = Math.floor(s / 60);
    const rem = s - m * 60;
    return `${m}m ${rem.toFixed(3)}s`;
}

/**
 * Convert UTC datetime string to epoch microseconds.
 * @param {string} utcString - e.g., "2009-11-03 13:36:00"
 * @returns {number}
 */
export function utcToEpochMicroseconds(utcString) {
    const date = new Date(utcString + ' UTC');
    return date.getTime() * 1000;
}

/**
 * Convert epoch microseconds to UTC datetime string.
 * @param {number} epochMicroseconds
 * @returns {string}
 */
export function epochMicrosecondsToUTC(epochMicroseconds) {
    const date = new Date(epochMicroseconds / 1000);
    return date.toISOString().replace('T', ' ').replace('Z', ' UTC');
}

/**
 * Create normalized connection key for flow matching.
 * Ensures consistent key regardless of direction.
 * @param {string} src_ip
 * @param {number} src_port
 * @param {string} dst_ip
 * @param {number} dst_port
 * @returns {string}
 */
export function makeConnectionKey(src_ip, src_port, dst_ip, dst_port) {
    const sp = (src_port === undefined || src_port === null || isNaN(src_port)) ? 0 : src_port;
    const dp = (dst_port === undefined || dst_port === null || isNaN(dst_port)) ? 0 : dst_port;
    const a = `${src_ip}:${sp}-${dst_ip}:${dp}`;
    const b = `${dst_ip}:${dp}-${src_ip}:${sp}`;
    return a < b ? a : b;
}

/**
 * Clamp a value between min and max.
 * @param {number} val
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
}

/**
 * Normalize protocol value to readable string.
 * @param {any} raw
 * @param {Object} protocolMap
 * @returns {string}
 */
export function normalizeProtocolValue(raw, protocolMap) {
    if (raw === undefined || raw === null || raw === '') return 'TCP';
    if (Array.isArray(raw)) raw = raw[0];
    if (typeof raw === 'string') {
        const upper = raw.trim().toUpperCase();
        if (/^\d+$/.test(upper)) {
            const num = parseInt(upper, 10);
            return protocolMap[num] ? `${protocolMap[num]} (${num})` : `Unknown (${num})`;
        }
        return upper || 'TCP';
    }
    if (typeof raw === 'number') {
        return protocolMap[raw] ? `${protocolMap[raw]} (${raw})` : `Unknown (${raw})`;
    }
    return 'TCP';
}

/**
 * Create a smart tick formatter that shows dates when data crosses day boundaries.
 * @param {Array<number>} timeExtent - [minTime, maxTime] in microseconds
 * @returns {Function} Formatter function for tick values
 */
export function createSmartTickFormatter(timeExtent) {
    // Check if data crosses day boundaries (different calendar days)
    const startDate = new Date(timeExtent[0] / 1000);
    const endDate = new Date(timeExtent[1] / 1000);
    const startDay = startDate.toISOString().substring(0, 10);
    const endDay = endDate.toISOString().substring(0, 10);
    const crossesDayBoundary = startDay !== endDay;

    return function(d) {
        const timestampInt = Math.floor(d);
        const date = new Date(timestampInt / 1000);
        if (crossesDayBoundary) {
            // Show month-day and time when crossing day boundaries: MM-DD HH:MM
            const isoStr = date.toISOString();
            return isoStr.substring(5, 10) + ' ' + isoStr.substring(11, 16);
        } else {
            // Show only time for single-day data: HH:MM:SS
            return date.toISOString().split('T')[1].split('.')[0];
        }
    };
}