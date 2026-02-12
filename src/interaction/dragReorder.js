// src/interaction/dragReorder.js
// Drag-to-reorder for IP rows

import { clamp } from '../utils/formatters.js';
import { TOP_PAD, ROW_GAP } from '../config/constants.js';

/**
 * Create drag behavior for IP row reordering.
 * @param {Object} options - {d3, svg, ipOrder, ipPositions, ipRowHeights, onReorder}
 * @returns {Object} D3 drag behavior
 */
export function createDragReorderBehavior(options) {
    const { d3, svg, ipOrder, ipPositions, ipRowHeights, onReorder } = options;

    /** Get the row height for an IP, respecting dynamic per-IP heights. */
    const getRowHeight = (ip) => (ipRowHeights && ipRowHeights.get(ip)) || ROW_GAP;

    /** Compute the maximum drag Y from cumulative row heights. */
    const getMaxY = () => {
        let y = TOP_PAD;
        for (let i = 0; i < ipOrder.length - 1; i++) {
            y += getRowHeight(ipOrder[i]);
        }
        return y;
    };

    /** Find the target index for a given y position using cumulative heights. */
    const getTargetIndex = (y) => {
        let cumY = TOP_PAD;
        for (let i = 0; i < ipOrder.length; i++) {
            const h = getRowHeight(ipOrder[i]);
            if (y < cumY + h / 2) return i;
            cumY += h;
        }
        return ipOrder.length - 1;
    };

    /** Rebuild ipPositions using per-IP row heights. */
    const rebuildPositions = () => {
        let currentY = TOP_PAD;
        ipOrder.forEach(ip => {
            ipPositions.set(ip, currentY);
            currentY += getRowHeight(ip);
        });
    };

    return d3.drag()
        .on('start', function(event, ip) {
            try { d3.select(this).raise(); } catch (_) {}
            d3.select(this).style('cursor', 'grabbing');
        })
        .on('drag', function(event, ip) {
            const maxY = getMaxY();
            const y = clamp(event.y, TOP_PAD, maxY);
            d3.select(this).attr('transform', `translate(0,${y})`);
        })
        .on('end', function(event, ip) {
            const maxY = getMaxY();
            const y = clamp(event.y, TOP_PAD, maxY);
            const targetIdx = getTargetIndex(y);

            const fromIdx = ipOrder.indexOf(ip);
            if (fromIdx === -1) return;

            if (fromIdx !== targetIdx) {
                // Reorder array
                ipOrder.splice(fromIdx, 1);
                ipOrder.splice(targetIdx, 0, ip);
                // Rebuild positions with per-IP row heights
                rebuildPositions();
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
