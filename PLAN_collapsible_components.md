# Implementation Plan: Collapsible Connected Components

## Overview
Allow users to expand/collapse individual connected components. Collapsed components use MIN_IP_SPACING (4px) and hide IP labels. Expanded components use MIN_IP_SPACING_WITHIN_COMPONENT (10px) and show IP labels.

## Implementation Steps

### 1. Add State Variable
**Location**: Line ~131 (with other state variables)

```javascript
// Component expansion state: compIdx -> boolean (true = expanded, false = collapsed)
let componentExpansionState = new Map(); // Default: all collapsed
```

### 2. Modify Spacing Calculation
**Location**: attack_timearcs.js:2435-2472 (finalYMap calculation)

**Change**:
```javascript
if (components && components.length > 1) {
  // Multi-component: group by component
  const componentGroups = [];
  sortedIps.forEach(ip => {
    const compIdx = ipToComponent.get(ip);
    if (compIdx !== undefined) {
      if (!componentGroups[compIdx]) componentGroups[compIdx] = [];
      componentGroups[compIdx].push(ip);
    }
  });

  const nonEmptyGroups = componentGroups.filter(g => g && g.length > 0);
  const interComponentGap = INTER_COMPONENT_GAP;

  let currentY = MARGIN.top + 12;
  nonEmptyGroups.forEach((group, idx) => {
    // Check expansion state (default collapsed)
    const isExpanded = componentExpansionState.get(idx) === true;
    const spacing = isExpanded ? MIN_IP_SPACING_WITHIN_COMPONENT : MIN_IP_SPACING;

    group.forEach(ip => {
      finalYMap.set(ip, currentY);
      currentY += spacing;
    });

    // Add gap after component (except last)
    if (idx < nonEmptyGroups.length - 1) {
      currentY += interComponentGap;
    }
  });

  dynamicInnerHeight = Math.max(INNER_HEIGHT, currentY - MARGIN.top + 25);
}
```

### 3. Conditional Label Visibility
**Location**: attack_timearcs.js:1290-1292 (after renderIpLabels)

**Add**:
```javascript
// Hide labels for collapsed components
ipLabels
  .style('opacity', d => {
    const compIdx = ipToComponent.get(d);
    if (compIdx === undefined) return 1; // Single component or no component info
    return componentExpansionState.get(compIdx) === true ? 1 : 0;
  });
```

**Also update**: Line 2613 (finalIpLabelsSelection animation) - add same opacity logic

### 4. Add Click Handler to Toggle Components
**Location**: After setupDragToBrush (around line 2181)

```javascript
// Component click-to-expand handler
svg.on('click.componentToggle', function(event) {
  // Don't toggle if clicking on brush or other interactive elements
  if (event.target.closest('.brush-group, .persistent-selection')) return;

  // Find which component was clicked based on Y coordinate
  const [clickX, clickY] = d3.pointer(event, this);

  // Find the IP at this Y position (or nearest)
  let clickedIp = null;
  let minDist = Infinity;
  sortedIps.forEach(ip => {
    const ipY = yScaleLens(ip);
    const dist = Math.abs(ipY - clickY);
    if (dist < minDist && dist < 20) { // Within 20px
      minDist = dist;
      clickedIp = ip;
    }
  });

  if (!clickedIp) return;

  const compIdx = ipToComponent.get(clickedIp);
  if (compIdx === undefined) return;

  // Toggle expansion state
  const wasExpanded = componentExpansionState.get(compIdx) === true;
  componentExpansionState.set(compIdx, !wasExpanded);

  console.log(`Component ${compIdx} ${wasExpanded ? 'collapsed' : 'expanded'}`);

  // Re-render with new spacing
  applyComponentLayout();
});
```

### 5. Create Layout Animation Function
**Location**: After autoFitArcs function (around line 2843)

```javascript
function applyComponentLayout() {
  // Recompute positions with current expansion state
  const newFinalYMap = new Map();
  let currentY = MARGIN.top + 12;

  if (components && components.length > 1) {
    const componentGroups = [];
    sortedIps.forEach(ip => {
      const compIdx = ipToComponent.get(ip);
      if (compIdx !== undefined) {
        if (!componentGroups[compIdx]) componentGroups[compIdx] = [];
        componentGroups[compIdx].push(ip);
      }
    });

    const nonEmptyGroups = componentGroups.filter(g => g && g.length > 0);

    nonEmptyGroups.forEach((group, idx) => {
      const isExpanded = componentExpansionState.get(idx) === true;
      const spacing = isExpanded ? MIN_IP_SPACING_WITHIN_COMPONENT : MIN_IP_SPACING;

      group.forEach(ip => {
        newFinalYMap.set(ip, currentY);
        currentY += spacing;
      });

      if (idx < nonEmptyGroups.length - 1) {
        currentY += INTER_COMPONENT_GAP;
      }
    });
  } else {
    // Single component - keep existing logic
    const step = Math.max(MIN_IP_SPACING, Math.min((INNER_HEIGHT - 25) / (sortedIps.length + 1), 15));
    for (let i = 0; i < sortedIps.length; i++) {
      newFinalYMap.set(sortedIps[i], MARGIN.top + 12 + i * step);
    }
  }

  const newDynamicHeight = Math.max(INNER_HEIGHT, currentY - MARGIN.top + 25);

  // Animate to new positions (600ms)
  const duration = 600;

  // Update row lines
  rows.selectAll('line')
    .transition().duration(duration)
    .attr('y1', d => newFinalYMap.get(d.ip))
    .attr('y2', d => newFinalYMap.get(d.ip));

  // Update labels (with opacity for collapsed)
  rows.selectAll('text')
    .transition().duration(duration)
    .attr('y', d => newFinalYMap.get(d))
    .style('opacity', d => {
      const compIdx = ipToComponent.get(d);
      if (compIdx === undefined) return 1;
      return componentExpansionState.get(compIdx) === true ? 1 : 0;
    });

  // Update arcs
  arcPaths.transition().duration(duration)
    .attrTween('d', function(d) {
      const xp = xScaleLens(d.minute);
      const y1Start = yScaleLens(d.sourceNode.name);
      const y2Start = yScaleLens(d.targetNode.name);
      const y1End = newFinalYMap.get(d.sourceNode.name) ?? y1Start;
      const y2End = newFinalYMap.get(d.targetNode.name) ?? y2Start;

      return function(t) {
        const y1t = y1Start + (y1End - y1Start) * t;
        const y2t = y2Start + (y2End - y2Start) * t;
        d.source.x = xp;
        d.source.y = y1t;
        d.target.x = xp;
        d.target.y = y2t;
        return linkArc(d);
      };
    })
    .on('end', function(d, i) {
      if (i === 0) {
        // Update yScaleLens to use new positions
        evenlyDistributedYPositions = newFinalYMap;
        // Update SVG height
        svg.attr('height', newDynamicHeight);
        // Update brush extent
        if (brushGroup && brush) {
          brush.extent([[MARGIN.left, MARGIN.top], [width + MARGIN.left, newDynamicHeight]]);
          brushGroup.call(brush);
        }
      }
    });

  // Update gradients
  linksWithNodes.forEach(d => {
    const xp = xScaleLens(d.minute);
    svg.select(`#${gradIdForLink(d)}`)
      .transition().duration(duration)
      .attr('y1', newFinalYMap.get(d.sourceNode.name))
      .attr('y2', newFinalYMap.get(d.targetNode.name));
  });
}
```

### 6. Initialize State on Render
**Location**: Line ~987 (start of render function, after originalData check)

```javascript
// Initialize component expansion state (default: all collapsed)
if (!isRenderingFilteredData && components && components.length > 1) {
  if (componentExpansionState.size === 0) {
    components.forEach((comp, idx) => {
      componentExpansionState.set(idx, false); // All collapsed by default
    });
    console.log(`Initialized ${components.length} components as collapsed`);
  }
}
```

## Summary

**What changes:**
1. Add `componentExpansionState` Map to track expanded/collapsed state
2. Use MIN_IP_SPACING (4px) for collapsed, MIN_IP_SPACING_WITHIN_COMPONENT (10px) for expanded
3. Hide labels when collapsed (opacity: 0)
4. Click anywhere on component area to toggle
5. Smooth 600ms animation on toggle

**Default behavior:**
- All components start collapsed (4px spacing, no labels)
- Click to expand (10px spacing, labels appear)
- Click again to collapse

**Files modified:**
- attack_timearcs.js (all changes in this one file)
