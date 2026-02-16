// src/utils/helpers.js
// Pure utility functions extracted from attack-network.js

/**
 * Safely convert value to number.
 * @param {*} v - Value to convert
 * @returns {number}
 */
export function toNumber(v) {
  const n = +v;
  return isFinite(n) ? n : 0;
}

/**
 * Sanitize string for SVG ID usage.
 * @param {string} s - Input string
 * @returns {string}
 */
export function sanitizeId(s) {
  return (s || '').toString().replace(/[^a-zA-Z0-9_-]+/g, '-');
}

/**
 * Canonicalize attack/group name for matching.
 * @param {string} s - Name to canonicalize
 * @returns {string}
 */
export function canonicalizeName(s) {
  return s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\s*\+\s*/g, ' + ')
    .trim();
}

/**
 * Show tooltip at event position.
 * @param {HTMLElement} tooltip - Tooltip element
 * @param {Event} evt - Mouse event
 * @param {string} html - Tooltip content
 */
export function showTooltip(tooltip, evt, html) {
  if (!tooltip) return;
  tooltip.style.display = 'block';
  if (html !== undefined) tooltip.innerHTML = html;
  const pad = 10;
  const x = (evt.pageX != null ? evt.pageX : evt.clientX) + pad;
  const y = (evt.pageY != null ? evt.pageY : evt.clientY) + pad;
  tooltip.style.left = x + 'px';
  tooltip.style.top = y + 'px';
}

/**
 * Hide tooltip.
 * @param {HTMLElement} tooltip - Tooltip element
 */
export function hideTooltip(tooltip) {
  if (!tooltip) return;
  tooltip.style.display = 'none';
}

/**
 * Update status message.
 * @param {HTMLElement} statusEl - Status element
 * @param {string} msg - Message to display
 */
export function setStatus(statusEl, msg) {
  if (statusEl) statusEl.textContent = msg;
}
