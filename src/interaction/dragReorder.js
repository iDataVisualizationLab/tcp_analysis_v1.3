// src/interaction/dragReorder.js
// Drag-to-reorder for IP rows

import { clamp } from '../utils/formatters.js';
import { TOP_PAD, ROW_GAP } from '../config/constants.js';

/**
 * Create drag behavior for IP row reordering.
 * @param {Object} options - {d3, svg, ipOrder, ipPositions, onReorder}
 * @returns {Object} D3 drag behavior
 */
export function createDragReorderBehavior(options) {
    const { d3, svg, ipOrder, ipPositions, onReorder } = options;

    return d3.drag()
        .on('start', function(event, ip) {
            try { d3.select(this).raise(); } catch (_) {}
            d3.select(this).style('cursor', 'grabbing');
        })
        .on('drag', function(event, ip) {
            const maxY = TOP_PAD + ROW_GAP * (ipOrder.length - 1);
            const y = clamp(event.y, TOP_PAD, maxY);
            d3.select(this).attr('transform', `translate(0,${y})`);
        })
        .on('end', function(event, ip) {
            const maxY = TOP_PAD + ROW_GAP * (ipOrder.length - 1);
            const y = clamp(event.y, TOP_PAD, maxY);
            let targetIdx = Math.round((y - TOP_PAD) / ROW_GAP);
            targetIdx = Math.max(0, Math.min(ipOrder.length - 1, targetIdx));

            const fromIdx = ipOrder.indexOf(ip);
            if (fromIdx === -1) return;

            if (fromIdx !== targetIdx) {
                // Reorder array
                ipOrder.splice(fromIdx, 1);
                ipOrder.splice(targetIdx, 0, ip);
                // Rebuild positions
                ipOrder.forEach((p, i) => ipPositions.set(p, TOP_PAD + i * ROW_GAP));
            }

            // Animate labels
            svg.selectAll('.node')
                .transition()
                .duration(150)
                .attr('transform', d => `translate(0,${ipPositions.get(d)})`)
                .on('end', function() {
                    d3.select(this).style('cursor', 'grab');
                });

            if (onReorder) onReorder();
        });
}
