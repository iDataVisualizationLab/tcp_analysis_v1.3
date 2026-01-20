// src/tcp/flags.js
// TCP flag classification and phase detection

/**
 * Classify TCP flags bitmask to readable string.
 * @param {number} flags - TCP flags bitmask
 * @returns {string} - Flag type like 'SYN', 'SYN+ACK', 'ACK', etc.
 */
export function classifyFlags(flags) {
    if (flags === undefined || flags === null) return 'OTHER';
    const flagMap = { 0x01: 'FIN', 0x02: 'SYN', 0x04: 'RST', 0x08: 'PSH', 0x10: 'ACK' };
    const setFlags = Object.entries(flagMap)
        .filter(([val, _]) => (flags & parseInt(val)) > 0)
        .map(([_, name]) => name)
        .sort();
    if (setFlags.length === 0) return 'OTHER';
    const flagStr = setFlags.join('+');
    // Normalize common combinations
    if (flagStr === 'ACK+SYN') return 'SYN+ACK';
    if (flagStr === 'ACK+FIN') return 'FIN+ACK';
    if (flagStr === 'ACK+PSH') return 'PSH+ACK';
    return flagStr;
}

/**
 * Helper to get flag type, supporting both camelCase (flagType) and snake_case (flag_type).
 * Python loaders output snake_case, JavaScript binning uses camelCase.
 * @param {Object} d - Data object (packet or binned data)
 * @returns {string} Flag type string like 'SYN', 'ACK', etc.
 */
export function getFlagType(d) {
    if (d.flagType !== undefined) return d.flagType;
    if (d.flag_type !== undefined) return d.flag_type;
    return d.flags !== undefined ? classifyFlags(d.flags) : 'OTHER';
}

/**
 * Map flag type to TCP phase.
 * @param {string} flagType
 * @returns {'establishment'|'data'|'closing'}
 */
export function flagPhase(flagType) {
    switch (flagType) {
        case 'SYN':
        case 'SYN+ACK':
        case 'ACK':
            return 'establishment';
        case 'PSH+ACK':
        case 'OTHER':
            return 'data';
        case 'FIN':
        case 'FIN+ACK':
        case 'RST':
        case 'ACK+RST':
            return 'closing';
        default:
            return 'data';
    }
}

/**
 * Check if flag is visible based on phase toggle states.
 * @param {string} flagType
 * @param {Object} phaseToggles - {showEstablishment, showDataTransfer, showClosing}
 * @returns {boolean}
 */
export function isFlagVisibleByPhase(flagType, phaseToggles) {
    const { showEstablishment = true, showDataTransfer = true, showClosing = true } = phaseToggles || {};
    const phase = flagPhase(flagType);
    if (phase === 'establishment') return !!showEstablishment;
    if (phase === 'data') return !!showDataTransfer;
    if (phase === 'closing') return !!showClosing;
    return true;
}

/**
 * Flag helper: check if packet has specific flag.
 * @param {Object} p - Packet with flags object
 * @param {string} f - Flag name
 * @returns {boolean}
 */
export const has = (p, f) => p.flags?.[f] === true;

/**
 * Check if packet is a SYN (no ACK, no RST).
 */
export const isSYN = p => has(p, 'syn') && !has(p, 'ack') && !has(p, 'rst');

/**
 * Check if packet is a SYN+ACK (no RST).
 */
export const isSYNACK = p => has(p, 'syn') && has(p, 'ack') && !has(p, 'rst');

/**
 * Check if packet is ACK only (no SYN, FIN, RST).
 */
export const isACKonly = p => has(p, 'ack') && !has(p, 'syn') && !has(p, 'fin') && !has(p, 'rst');

/**
 * Get colored flag badges HTML for stats display.
 * @param {Object} flagStats - {flagType: count}
 * @param {Object} flagColors - {flagType: color}
 * @returns {string} HTML string
 */
export function getColoredFlagBadges(flagStats, flagColors) {
    const flagsWithCounts = Object.entries(flagStats)
        .filter(([flag, count]) => count > 0)
        .sort(([, a], [, b]) => b - a);

    if (flagsWithCounts.length === 0) {
        return '<span style="color: #999; font-style: italic;">None</span>';
    }

    return flagsWithCounts.map(([flag, count]) => {
        const color = flagColors[flag] || '#bdc3c7';
        return `<span style="
            display: inline-block;
            background-color: ${color};
            color: white;
            padding: 2px 6px;
            border-radius: 3px;
            font-size: 10px;
            font-weight: bold;
            text-shadow: 0 1px 2px rgba(0,0,0,0.3);
            min-width: 20px;
            text-align: center;
        " title="${flag}: ${count.toLocaleString()} packets">
            ${flag}: ${count.toLocaleString()}
        </span>`;
    }).join('');
}

/**
 * Get top N flags as summary string.
 * @param {Object} flagStats - {flagType: count}
 * @param {number} n - Number of top flags
 * @returns {string}
 */
export function getTopFlags(flagStats, n = 3) {
    return Object.entries(flagStats)
        .filter(([flag, count]) => count > 0)
        .sort(([, a], [, b]) => b - a)
        .slice(0, n)
        .map(([flag, count]) => `${flag}(${count})`)
        .join(', ') || 'None';
}