import { MARGIN, DEFAULT_WIDTH, DEFAULT_HEIGHT, INNER_HEIGHT, MIN_IP_SPACING, MIN_IP_SPACING_WITHIN_COMPONENT, INTER_COMPONENT_GAP, PROTOCOL_COLORS, DEFAULT_COLOR, NEUTRAL_GREY } from './src/config/constants.js';
import { toNumber, sanitizeId, canonicalizeName, showTooltip, hideTooltip, setStatus } from './src/utils/helpers.js';
import { decodeIp, decodeAttack, decodeAttackGroup, lookupAttackColor, lookupAttackGroupColor } from './src/mappings/decoders.js';
import { buildRelationships, computeConnectivityFromRelationships, computeLinks, findConnectedComponents } from './src/data/aggregation.js';
import { componentLoader } from './src/data/component-loader.js';
import { linkArc, gradientIdForLink } from './src/rendering/arcPath.js';
import { buildLegend as createLegend, updateLegendVisualState as updateLegendUI, isolateAttack as isolateLegendAttack } from './src/ui/legend.js';
import { parseCSVStream, parseCSVLine } from './src/data/csvParser.js';
import { detectTimestampUnit, createToDateConverter, createTimeScale, createIpScale, createWidthScale, calculateMaxArcRadius } from './src/scales/scaleFactory.js';
import { createForceSimulation, runUntilConverged, createComponentSeparationForce, createWeakComponentSeparationForce, createComponentCohesionForce, createHubCenteringForce, createComponentYForce, initializeNodePositions, calculateComponentCenters, findComponentHubIps, calculateIpDegrees, calculateConnectionStrength, createMutualHubAttractionForce } from './src/layout/forceSimulation.js';
import { createLensXScale } from './src/scales/distortion.js';
import { updateFocusRegion, computeLayoutWidths } from './src/scales/bifocal.js';
import { createBifocalHandles } from './src/ui/bifocal-handles.js';
import { computeIpSpans, createSpanData, renderRowLines, renderIpLabels, createLabelHoverHandler, createLabelMoveHandler, createLabelLeaveHandler, attachLabelHoverHandlers, renderComponentToggles, updateComponentToggles, showComponentToggles } from './src/rendering/rows.js';
import { createArcHoverHandler, createArcMoveHandler, createArcLeaveHandler, attachArcHandlers } from './src/rendering/arcInteractions.js';
import { loadAllMappings } from './src/mappings/loaders.js';
import { setupWindowResizeHandler as setupWindowResizeHandlerFromModule } from './src/interaction/resize.js';
import { ForceNetworkLayout } from './src/layout/force_network.js';

// Network TimeArcs visualization
// Input CSV schema: timestamp,length,src_ip,dst_ip,protocol,count
// - timestamp: integer absolute minutes. If very large (>1e6), treated as minutes since Unix epoch.
//   Otherwise treated as relative minutes and displayed as t=.. labels.

(function () {
  const fileInput = document.getElementById('fileInput');
  const statusEl = document.getElementById('status');
  const svg = d3.select('#chart');
  const container = document.getElementById('chart-container');
  const legendEl = document.getElementById('legend');
  const tooltip = document.getElementById('tooltip');
  const labelModeRadios = document.querySelectorAll('input[name="labelMode"]');
  const brushStatusEl = document.getElementById('brushStatus');
  const brushStatusText = document.getElementById('brushStatusText');
  const clearBrushBtn = document.getElementById('clearBrush');

  // Legend panel collapse/expand functionality
  const legendPanel = document.getElementById('legendPanel');
  const legendPanelHeader = document.getElementById('legendPanelHeader');

  let legendPanelDragState = null;
  let legendPanelCollapsed = false;

  function toggleLegendCollapse() {
    if (legendPanel) {
      legendPanelCollapsed = !legendPanelCollapsed;
      if (legendPanelCollapsed) {
        legendPanel.classList.add('collapsed');
      } else {
        legendPanel.classList.remove('collapsed');
      }
    }
  }

  // Make legend panel draggable and collapsible
  if (legendPanel && legendPanelHeader) {
    let clickStartTime = 0;
    let clickStartPos = { x: 0, y: 0 };

    legendPanelHeader.addEventListener('mousedown', (e) => {
      clickStartTime = Date.now();
      clickStartPos = { x: e.clientX, y: e.clientY };

      const rect = legendPanel.getBoundingClientRect();
      legendPanelDragState = {
        offsetX: e.clientX - rect.left,
        offsetY: e.clientY - rect.top,
        startX: e.clientX,
        startY: e.clientY,
        hasMoved: false
      };

      document.addEventListener('mousemove', onLegendPanelDrag);
      document.addEventListener('mouseup', onLegendPanelDragEnd);
      e.preventDefault();
    });
  }

  function onLegendPanelDrag(e) {
    if (!legendPanelDragState || !legendPanel) return;

    const dragDistance = Math.sqrt(
      Math.pow(e.clientX - legendPanelDragState.startX, 2) +
      Math.pow(e.clientY - legendPanelDragState.startY, 2)
    );

    // Only start dragging if moved more than 5 pixels
    if (dragDistance > 5) {
      legendPanelDragState.hasMoved = true;
      legendPanelHeader.style.cursor = 'grabbing';

      const newLeft = e.clientX - legendPanelDragState.offsetX;
      const newTop = e.clientY - legendPanelDragState.offsetY;

      // Keep within viewport bounds
      const maxLeft = window.innerWidth - legendPanel.offsetWidth;
      const maxTop = window.innerHeight - legendPanel.offsetHeight;

      legendPanel.style.left = Math.max(0, Math.min(newLeft, maxLeft)) + 'px';
      legendPanel.style.top = Math.max(0, Math.min(newTop, maxTop)) + 'px';
      legendPanel.style.right = 'auto'; // Override right positioning when dragging
    }
  }

  function onLegendPanelDragEnd(e) {
    if (legendPanelDragState && !legendPanelDragState.hasMoved) {
      // This was a click, not a drag - toggle collapse
      toggleLegendCollapse();
    }

    legendPanelDragState = null;
    if (legendPanelHeader) {
      legendPanelHeader.style.cursor = 'pointer';
    }
    document.removeEventListener('mousemove', onLegendPanelDrag);
    document.removeEventListener('mouseup', onLegendPanelDragEnd);
  }

  // Progress bar elements
  const loadingProgressEl = document.getElementById('loadingProgress');
  const progressBarEl = document.getElementById('progressBar');
  const progressTextEl = document.getElementById('progressText');

  // Bifocal controls (always enabled, no toggle button)
  const compressionSlider = document.getElementById('compressionSlider');
  const compressionValue = document.getElementById('compressionValue');
  const bifocalRegionIndicator = document.getElementById('bifocalRegionIndicator');
  const bifocalRegionText = document.getElementById('bifocalRegionText');

  // IP Communications panel elements
  const ipCommHeader = document.getElementById('ip-comm-header');
  const ipCommContent = document.getElementById('ip-comm-content');
  const ipCommToggle = document.getElementById('ip-comm-toggle');
  const ipCommList = document.getElementById('ip-comm-list');
  const exportIPListBtn = document.getElementById('exportIPList');

  // Store IP pairs data for export
  let currentPairsByFile = null;

  // Setup collapsible panel toggle
  if (ipCommHeader) {
    ipCommHeader.addEventListener('click', (e) => {
      // Don't toggle if clicking on the export button
      if (e.target.id === 'exportIPList' || e.target.closest('#exportIPList')) return;
      const isVisible = ipCommContent.style.display !== 'none';
      ipCommContent.style.display = isVisible ? 'none' : 'block';
      ipCommToggle.style.transform = isVisible ? 'rotate(0deg)' : 'rotate(180deg)';
    });
  }

  // Setup IP list export button
  if (exportIPListBtn) {
    exportIPListBtn.addEventListener('click', (e) => {
      e.stopPropagation(); // Prevent panel toggle
      exportIPListToFile();
    });
  }

  // Export IP list to file
  function exportIPListToFile() {
    if (!currentPairsByFile || currentPairsByFile.size === 0) {
      alert('No IP communications data to export. Please load data first.');
      return;
    }

    // Build text content grouped by file
    let content = '';
    const sortedFiles = Array.from(currentPairsByFile.keys()).sort();

    sortedFiles.forEach(file => {
      const pairs = Array.from(currentPairsByFile.get(file)).sort();
      content += `${file}\n`;
      pairs.forEach(pair => {
        content += `${pair}\n`;
      });
      content += '\n';
    });

    // Create and download file
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ip_communications.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    console.log('Exported IP communications to ip_communications.txt');
  }

  // User-selected labeling mode: 'timearcs' or 'force_layout'
  let labelMode = 'force_layout';

  // Force layout mode state
  let layoutMode = 'force_layout'; // 'timearcs' | 'force_layout'
  let forceLayout = null;      // ForceNetworkLayout instance (null when in timearcs mode)
  let forceLayoutLayer = null;  // <g> for force layout rendering
  let layoutTransitionInProgress = false; // Guard against rapid switching
  
  // Brush selection state
  // Brush is always available - user can click and drag anywhere to select
  let brushSelection = null; // Current brush selection {x0, y0, x1, y1}
  let selectedArcs = []; // Arcs within brush selection
  let selectedIps = new Set(); // IPs involved in selection
  let selectionTimeRange = null; // {min, max} in data units

  // Drag detection for brush vs hover
  const DRAG_THRESHOLD = 8; // pixels before drag is recognized as brush intent
  let dragStart = null; // {x, y} of mousedown
  let isDragging = false; // true when drag exceeds threshold

  // Multiple brush selections support
  let multiSelectionsGroup = null; // SVG group for persistent selections
  let persistentSelections = []; // Array of {id, bounds, arcs, ips, timeRange}
  let selectionIdCounter = 0;
  
  // Timestamp information (needed for export)
  let currentTimeInfo = null; // Stores {unit, looksAbsolute, unitMs, base, activeLabelKey}

  // Current vertical order of IPs (for passing to other visualizations)
  let currentSortedIps = []; // Updated after force simulation and sorting

  // Component expansion state: compIdx -> boolean (true = expanded, false = collapsed)
  let componentExpansionState = new Map(); // Default: all collapsed

  // Dataset configuration: maps time ranges to data files
  // This will be populated based on loaded data or can be configured manually
  let datasetConfig = {
    // Time is in the data's native unit (e.g., minutes since epoch)
    // Will be auto-detected from loaded files or can be set manually
    sets: [],
    baseDataPath: './',  // Base path for data files
    ipMapPath: './full_ip_map.json',  // Default IP map path
    autoDetected: false,
    // Path to multi-resolution data for ip_bar_diagram detail view
    // This should point to a folder with manifest.json compatible with ip_bar_diagram
    detailViewDataPath: 'packets_data/attack_packets_day1to5'
  };
  
  // Store loaded file info for smart detection
  let loadedFileInfo = [];
  labelModeRadios.forEach(r => r.addEventListener('change', () => {
    const sel = Array.from(labelModeRadios).find(r => r.checked);
    const newMode = sel ? sel.value : 'timearcs';
    if (newMode === layoutMode || layoutTransitionInProgress) return;

    const prev = layoutMode;
    layoutMode = newMode;
    labelMode = newMode; // preserve backward compat for colorForAttack

    if (prev === 'timearcs' && newMode === 'force_layout') {
      transitionToForceLayout();
    } else if (prev === 'force_layout' && newMode === 'timearcs') {
      transitionToTimearcs();
    }
  }));

  // Handle bifocal compression slider
  if (compressionSlider && compressionValue) {
    compressionSlider.addEventListener('input', (e) => {
      bifocalState.compressionRatio = parseFloat(e.target.value);
      compressionValue.textContent = `${bifocalState.compressionRatio}x`;

      // Recompute layout widths
      const widths = computeLayoutWidths(bifocalState);
      bifocalState = { ...bifocalState, ...widths };

      // Update visualization (bifocal always active)
      if (updateBifocalVisualizationFn) {
        updateBifocalVisualizationFn();
      }
    });
  }

  // Handle keyboard shortcuts for bifocal navigation
  document.addEventListener('keydown', (e) => {
    // Arrow keys: navigate bifocal focus
    if (e.key.startsWith('Arrow')) {
      const step = e.shiftKey ? 0.1 : 0.02; // Shift for large steps
      const focusSpan = bifocalState.focusEnd - bifocalState.focusStart;

      if (e.key === 'ArrowLeft') {
        // Move focus region left
        e.preventDefault();
        const newStart = Math.max(0, bifocalState.focusStart - step);
        const newState = updateFocusRegion(bifocalState, newStart, newStart + focusSpan);
        bifocalState = newState;
        if (updateBifocalVisualizationFn) {
          updateBifocalVisualizationFn();
        }
      } else if (e.key === 'ArrowRight') {
        // Move focus region right
        e.preventDefault();
        const newEnd = Math.min(1, bifocalState.focusEnd + step);
        const newState = updateFocusRegion(bifocalState, newEnd - focusSpan, newEnd);
        bifocalState = newState;
        if (updateBifocalVisualizationFn) {
          updateBifocalVisualizationFn();
        }
      } else if (e.key === 'ArrowUp') {
        // Expand focus region
        e.preventDefault();
        const expandStep = step / 2;
        const newState = updateFocusRegion(
          bifocalState,
          Math.max(0, bifocalState.focusStart - expandStep),
          Math.min(1, bifocalState.focusEnd + expandStep)
        );
        bifocalState = newState;
        if (updateBifocalVisualizationFn) {
          updateBifocalVisualizationFn();
        }
      } else if (e.key === 'ArrowDown') {
        // Contract focus region
        e.preventDefault();
        const contractStep = step / 2;
        const center = (bifocalState.focusStart + bifocalState.focusEnd) / 2;
        const newSpan = Math.max(0.05, focusSpan - contractStep * 2);
        const newState = updateFocusRegion(bifocalState, center - newSpan / 2, center + newSpan / 2);
        bifocalState = newState;
        if (updateBifocalVisualizationFn) {
          updateBifocalVisualizationFn();
        }
      }
    }
  });

  // Update brush status indicator
  function updateBrushStatus(text, isActive = false) {
    if (!brushStatusEl || !brushStatusText) return;
    brushStatusText.textContent = text;
    if (isActive) {
      brushStatusEl.style.background = '#e7f5ff';
      brushStatusEl.style.borderColor = '#74c0fc';
    } else {
      brushStatusEl.style.background = '#f8f9fa';
      brushStatusEl.style.borderColor = '#dee2e6';
    }
  }

  // Progress bar helper functions
  function showProgress() {
    if (loadingProgressEl) {
      loadingProgressEl.style.display = 'block';
      statusEl.style.display = 'none';
    }
  }

  function hideProgress() {
    if (loadingProgressEl) {
      loadingProgressEl.style.display = 'none';
      statusEl.style.display = 'block';
    }
  }

  function updateProgress(text, percent) {
    if (progressTextEl) {
      progressTextEl.textContent = text;
    }
    if (progressBarEl) {
      progressBarEl.style.width = `${Math.min(100, Math.max(0, percent))}%`;
    }
  }

  // Handle clear brush button
  if (clearBrushBtn) {
    clearBrushBtn.addEventListener('click', () => {
      console.log('Clearing brush selection');
      if (layoutMode === 'force_layout') {
        // In force layout mode, clear time filter (show all data)
        if (forceLayout) forceLayout.updateTimeFilter(null);
      } else if (typeof clearBrushSelectionFn === 'function') {
        clearBrushSelectionFn();
      }
    });
  }


  let width = DEFAULT_WIDTH; // updated on render
  let height = DEFAULT_HEIGHT; // updated on render

  // When true, hide baseline labels and only show magnified ones
  let labelsCompressedMode = false;

  // Store original Y positions for each IP
  let originalRowPositions = new Map();

  // Render generation counter to cancel stale async renders
  let renderGeneration = 0;

  // Cached simulation layout (IP ordering) — only recomputed on new data, not filtered re-renders
  let cachedLayoutResult = null; // { yMap, components, ipToComponent, simNodes, allIps, nodes }
  let cachedDynamicHeight = null; // SVG height for timearcs mode (deferred when force layout loads first)

  // Bifocal display state (timeline focus+context) - ALWAYS ENABLED
  let bifocalEnabled = true;  // Always on by default
  let bifocalState = {
    focusStart: 0.0,           // Start with full overview
    focusEnd: 1.0,             // Full timeline visible
    compressionRatio: 3.0,     // Context compression factor
    leftContextWidth: 0.0,     // Computed screen width (no left context initially)
    focusWidth: 1.0,           // Full width for focus initially
    rightContextWidth: 0.0     // Computed screen width (no right context initially)
  };
  let bifocalHandles = null; // Drag handle UI elements

  // Function to update bifocal region indicator text
  function updateBifocalRegionText() {
    if (bifocalRegionText) {
      const startPct = Math.round(bifocalState.focusStart * 100);
      const endPct = Math.round(bifocalState.focusEnd * 100);
      bifocalRegionText.textContent = `Focus: ${startPct}% - ${endPct}%`;
    }
  }

  // IP map state (id -> dotted string)
  let ipIdToAddr = null; // Map<number, string>
  let ipMapLoaded = false;

  // Attack/event mapping: id -> name, and color mapping: name -> color
  let attackIdToName = null; // Map<number, string>
  let colorByAttack = null; // Map<string, string> by canonicalized name
  let rawColorByAttack = null; // original keys
  // Attack group mapping/color
  let attackGroupIdToName = null; // Map<number,string>
  let colorByAttackGroup = null; // canonical map
  let rawColorByAttackGroup = null;

  // Track visible attacks for legend filtering
  let visibleAttacks = new Set(); // Set of attack names that are currently visible
  let currentArcPaths = null; // Reference to arc paths selection for visibility updates
  let currentLabelMode = 'timearcs'; // Track current label mode for filtering

  // Reference to updateBifocalVisualization function
  let updateBifocalVisualizationFn = null;

  // Store original unfiltered data for legend filtering and resize re-render
  let originalData = null;
  // Cache computed links from originalData to avoid recomputing on every render
  let cachedOriginalLinks = null;
  // Flag to track if we're rendering filtered data (to prevent overwriting originalData)
  let isRenderingFilteredData = false;
  // Cleanup function for resize handler
  let resizeCleanup = null;

  // Module-level references set during render() for force layout transitions
  let _renderLinksWithNodes = null;  // linksWithNodes from last render
  let _renderAllIps = null;          // allIps from last render
  let _renderIpToComponent = null;   // ipToComponent from last render
  let _renderComponents = null;      // components from last render
  let _renderYScaleLens = null;      // yScaleLens from last render
  let _renderXScaleLens = null;      // xScaleLens from last render (for split transition)
  let _renderXStart = null;          // xStart from last render
  let _renderColorForAttack = null;  // colorForAttack from last render
  let _renderTsMin = null;           // tsMin from last render
  let _renderTsMax = null;           // tsMax from last render

  // Initialize mappings, then try a default CSV load
  (async function init() {
    try {
      const mappings = await loadAllMappings(canonicalizeName);
      ipIdToAddr = mappings.ipIdToAddr;
      ipMapLoaded = ipIdToAddr !== null && ipIdToAddr.size > 0;
      attackIdToName = mappings.attackIdToName;
      colorByAttack = mappings.colorByAttack;
      rawColorByAttack = mappings.rawColorByAttack;
      attackGroupIdToName = mappings.attackGroupIdToName;
      colorByAttackGroup = mappings.colorByAttackGroup;
      rawColorByAttackGroup = mappings.rawColorByAttackGroup;

      if (ipMapLoaded) {
        setStatus(statusEl, `IP map loaded (${ipIdToAddr.size} entries). Upload CSV to render.`);
      }
    } catch (err) {
      console.warn('Mapping load failed:', err);
    }
    // Setup window resize handler
    resizeCleanup = setupWindowResizeHandler();
    // After maps are ready (or failed gracefully), try default CSV
    tryLoadDefaultCsv();
  })();
  
  // Window resize handler for responsive visualization
  function setupWindowResizeHandler() {
    const handleResizeLogic = () => {
      try {
        // Only proceed if we have data to re-render
        if (!originalData || originalData.length === 0) {
          return;
        }

        console.log('Handling window resize, updating visualization dimensions');

        // Store old dimensions for comparison
        const oldWidth = width;
        const oldHeight = height;

        const containerEl = document.getElementById('chart-container');
        if (!containerEl) return;

        // Calculate new dimensions
        const containerRect = containerEl.getBoundingClientRect();
        const availableWidth = containerRect.width || 1200;
        const viewportWidth = Math.max(availableWidth, 800);
        const newWidth = viewportWidth - MARGIN.left - MARGIN.right;

        // Skip if dimensions haven't changed significantly
        if (Math.abs(newWidth - oldWidth) < 10) {
          return;
        }

        console.log(`Resize: ${oldWidth}x${oldHeight} -> ${newWidth}x${height}`);

        // In force layout mode, update dimensions and re-render
        if (layoutMode === 'force_layout' && forceLayout) {
          forceLayout.width = newWidth + MARGIN.left + MARGIN.right;
          forceLayout.height = height;
          if (forceLayoutLayer) {
            forceLayout.render(forceLayoutLayer);
          }
          return;
        }

        // Re-render with current filter state (filtered or unfiltered)
        // applyAttackFilter will render originalData if all attacks visible,
        // or filter and render if some attacks are hidden
        applyAttackFilter();

        console.log('Window resize handling complete');

      } catch (e) {
        console.warn('Error during window resize:', e);
      }
    };
    
    // Use module's resize handler with our custom logic
    return setupWindowResizeHandlerFromModule({
      debounceMs: 200,
      onResize: handleResizeLogic
    });
  }

  // Stream-parse a CSV file incrementally to avoid loading entire file into memory
  // Pushes transformed rows directly into combinedData, returns {totalRows, validRows}
  async function processCsvFile(file, combinedData, options = { hasHeader: true, delimiter: ',', onProgress: null }) {
    const fileName = file.name;
    const result = await parseCSVStream(file, (obj, idx) => {
      const attackName = _decodeAttack(obj.attack);
      const attackGroupName = _decodeAttackGroup(obj.attack_group, obj.attack);
      const rec = {
        idx: combinedData.length,
        timestamp: toNumber(obj.timestamp),
        length: toNumber(obj.length),
        src_ip: _decodeIp(obj.src_ip),
        dst_ip: _decodeIp(obj.dst_ip),
        protocol: (obj.protocol || '').toUpperCase() || 'OTHER',
        count: toNumber(obj.count) || 1,
        attack: attackName,
        attack_group: attackGroupName,
        sourceFile: fileName,  // Track which file this record came from
      };

      const hasValidTimestamp = isFinite(rec.timestamp);
      const hasValidSrcIp = rec.src_ip && rec.src_ip !== 'N/A' && !String(rec.src_ip).startsWith('IP_');
      const hasValidDstIp = rec.dst_ip && rec.dst_ip !== 'N/A' && !String(rec.dst_ip).startsWith('IP_');

      if (hasValidTimestamp && hasValidSrcIp && hasValidDstIp) {
        combinedData.push(rec);
        return true;
      }
      return false;
    }, options);

    return {
      fileName: result.fileName,
      totalRows: result.totalRows,
      validRows: result.validRows
    };
  }

  // Transform raw CSV rows to processed data
  function transformRows(rows, startIdx = 0) {
    return rows.map((d, i) => {
      const attackName = _decodeAttack(d.attack);
      const attackGroupName = _decodeAttackGroup(d.attack_group, d.attack);
      const srcIp = _decodeIp(d.src_ip);
      const dstIp = _decodeIp(d.dst_ip);
      return {
        idx: startIdx + i,
        timestamp: toNumber(d.timestamp),
        length: toNumber(d.length),
        src_ip: srcIp,
        dst_ip: dstIp,
        protocol: (d.protocol || '').toUpperCase() || 'OTHER',
        count: toNumber(d.count) || 1,
        attack: attackName,
        attack_group: attackGroupName,
      };
    }).filter(d => {
      // Filter out records with invalid data
      const hasValidTimestamp = isFinite(d.timestamp);
      const hasValidSrcIp = d.src_ip && d.src_ip !== 'N/A' && !d.src_ip.startsWith('IP_');
      const hasValidDstIp = d.dst_ip && d.dst_ip !== 'N/A' && !d.dst_ip.startsWith('IP_');
      
      // Debug logging for filtered records
      if (!hasValidSrcIp || !hasValidDstIp) {
        console.log('Filtering out record:', { 
          src_ip: d.src_ip, 
          dst_ip: d.dst_ip, 
          hasValidSrcIp, 
          hasValidDstIp,
          ipMapLoaded,
          ipMapSize: ipIdToAddr ? ipIdToAddr.size : 0
        });
      }
      
      return hasValidTimestamp && hasValidSrcIp && hasValidDstIp;
    });
  }

  // Handle CSV upload - supports multiple files
  fileInput?.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    // Show progress bar
    showProgress();

    try {
      // === CLEANUP: Free memory from previous data BEFORE loading new data ===
      // This prevents having both old and new data in memory simultaneously
      if (originalData) {
        originalData.length = 0; // Clear array contents
        originalData = null;
      }

      // Clear cached computed data
      if (cachedOriginalLinks) {
        cachedOriginalLinks.length = 0;
        cachedOriginalLinks = null;
      }

      // Clear selection and UI state
      visibleAttacks.clear();
      selectedArcs = [];
      selectedIps.clear();
      brushSelection = null;
      selectionTimeRange = null;
      persistentSelections = [];
      currentPairsByFile = null;

      // Clear multi-selection group if it exists
      if (multiSelectionsGroup) {
        multiSelectionsGroup.selectAll('*').remove();
        multiSelectionsGroup = null;
      }

      // Clear current sorted IPs
      currentSortedIps = [];

      // Clear chart SVG to free DOM memory
      svg.selectAll('*').remove();
      d3.select('#axis-top').selectAll('*').remove();

      console.log('Pre-load cleanup completed - old data freed before loading new files');
      // === END CLEANUP ===

      console.log('Processing CSV files with IP map status:', {
        fileCount: files.length,
        ipMapLoaded,
        ipMapSize: ipIdToAddr ? ipIdToAddr.size : 0
      });

      // Warn if IP map is not loaded
      if (!ipMapLoaded || !ipIdToAddr || ipIdToAddr.size === 0) {
        console.warn('IP map not loaded or empty. Some IP IDs may not be mapped correctly.');
        setStatus(statusEl,'Warning: IP map not loaded. Some data may be filtered out.');
      }

      // Reset loaded file info
      loadedFileInfo = [];
      
      // Process files sequentially to bound memory; stream-parse to avoid full-file buffers
      const combinedData = [];
      const fileStats = [];
      const errors = [];
      for (let fileIdx = 0; fileIdx < files.length; fileIdx++) {
        const file = files[fileIdx];
        try {
          const startIdx = combinedData.length;

          // Update progress: show which file we're processing
          const fileNum = fileIdx + 1;
          const baseProgress = (fileIdx / files.length) * 100;
          const fileProgressRange = 100 / files.length;

          updateProgress(
            files.length === 1
              ? `Loading ${file.name}...`
              : `Loading file ${fileNum}/${files.length}: ${file.name}`,
            baseProgress
          );

          // Process file with progress callback
          const res = await processCsvFile(file, combinedData, {
            hasHeader: true,
            delimiter: ',',
            onProgress: (bytesProcessed, totalBytes) => {
              const filePercent = (bytesProcessed / totalBytes) * fileProgressRange;
              const totalPercent = baseProgress + filePercent;
              updateProgress(
                files.length === 1
                  ? `Loading ${file.name}... ${Math.round((bytesProcessed / totalBytes) * 100)}%`
                  : `Loading file ${fileNum}/${files.length}: ${file.name} (${Math.round((bytesProcessed / totalBytes) * 100)}%)`,
                totalPercent
              );
            }
          });
          const filteredRows = res.totalRows - res.validRows;
          
          // Track time range for this file (use efficient iteration to avoid stack overflow)
          const fileData = combinedData.slice(startIdx);
          let fileMinTime = null;
          let fileMaxTime = null;
          if (fileData.length > 0) {
            fileMinTime = Infinity;
            fileMaxTime = -Infinity;
            for (let i = 0; i < fileData.length; i++) {
              const ts = fileData[i].timestamp;
              if (isFinite(ts)) {
                if (ts < fileMinTime) fileMinTime = ts;
                if (ts > fileMaxTime) fileMaxTime = ts;
              }
            }
            if (fileMinTime === Infinity) fileMinTime = null;
            if (fileMaxTime === -Infinity) fileMaxTime = null;
          }
          
          fileStats.push({ fileName: file.name, totalRows: res.totalRows, validRows: res.validRows, filteredRows });
          
          // Store file info for smart detection
          const decodedFileName = mapToDecodedFilename(file.name);
          loadedFileInfo.push({
            fileName: file.name, // Original timearcs filename
            decodedFileName: decodedFileName, // Mapped to Python input filename
            filePath: file.name, // Browser doesn't expose full path, user may need to adjust
            minTime: fileMinTime,
            maxTime: fileMaxTime,
            recordCount: fileData.length,
            // Try to detect set/day from filename
            setNumber: detectSetNumber(file.name),
            dayNumber: detectDayNumber(file.name)
          });
        } catch (err) {
          errors.push({ fileName: file.name, error: err });
          console.error(`Failed to load ${file.name}:`, err);
        }
      }
      
      // Update dataset config with loaded file info
      updateDatasetConfig();
      
      // Disable rebuild cache for huge datasets to avoid memory spikes
      lastRawCsvRows = null;

      // Hide progress bar
      hideProgress();

      if (combinedData.length === 0) {
        if (errors.length > 0) {
          setStatus(statusEl,`Failed to load files. ${errors.length} error(s) occurred.`);
        } else {
          setStatus(statusEl,'No valid rows found. Ensure CSV files have required columns and IP mappings are available.');
        }
        clearChart();
        return;
      }
      
      // Build status message with summary
      const successfulFiles = fileStats.length;
      const totalValidRows = combinedData.length;
      const totalFilteredRows = fileStats.reduce((sum, stat) => sum + stat.filteredRows, 0);
      
      let statusMsg = '';
      if (files.length === 1) {
        // Single file: show simple message
        if (totalFilteredRows > 0) {
          statusMsg = `Loaded ${totalValidRows} valid rows (${totalFilteredRows} rows filtered due to missing IP mappings)`;
        } else {
          statusMsg = `Loaded ${totalValidRows} records`;
        }
      } else {
        // Multiple files: show detailed summary
        const fileSummary = fileStats.map(stat => 
          `${stat.fileName} (${stat.validRows} valid${stat.filteredRows > 0 ? `, ${stat.filteredRows} filtered` : ''})`
        ).join('; ');
        
        statusMsg = `Loaded ${successfulFiles} file(s): ${fileSummary}. Total: ${totalValidRows} records`;
        
        if (errors.length > 0) {
          statusMsg += `. ${errors.length} file(s) failed to load.`;
        }
      }
      
      setStatus(statusEl,statusMsg);

      // Render new data (cleanup already done at the start of this handler)
      render(combinedData);
    } catch (err) {
      console.error(err);
      hideProgress();
      setStatus(statusEl,'Failed to read CSV file(s).');
      clearChart();
    }
  });



  // Keep last raw CSV rows so we can rebuild when mappings change
  let lastRawCsvRows = null; // array of raw objects from csvParse

  function rebuildDataFromRawRows(rows){
    return rows.map((d, i) => {
      const attackName = _decodeAttack(d.attack);
      const attackGroupName = _decodeAttackGroup(d.attack_group, d.attack);
      return {
        idx: i,
        timestamp: toNumber(d.timestamp),
        length: toNumber(d.length),
        src_ip: _decodeIp(d.src_ip),
        dst_ip: _decodeIp(d.dst_ip),
        protocol: (d.protocol || '').toUpperCase() || 'OTHER',
        count: toNumber(d.count) || 1,
        attack: attackName,
        attack_group: attackGroupName,
      };
    }).filter(d => {
      // Filter out records with invalid data
      const hasValidTimestamp = isFinite(d.timestamp);
      const hasValidSrcIp = d.src_ip && d.src_ip !== 'N/A' && !d.src_ip.startsWith('IP_');
      const hasValidDstIp = d.dst_ip && d.dst_ip !== 'N/A' && !d.dst_ip.startsWith('IP_');
      return hasValidTimestamp && hasValidSrcIp && hasValidDstIp;
    });
  }

  async function tryLoadDefaultCsv() {
    const defaultPath = './set1_first90_minutes.csv';
    try {
      const res = await fetch(defaultPath, { cache: 'no-store' });
      if (!res.ok) return; // quietly exit if not found
      const text = await res.text();
      const rows = d3.csvParse((text || '').trim());
      lastRawCsvRows = rows; // cache raw rows
      const data = rows.map((d, i) => {
        const attackName = _decodeAttack(d.attack);
        const attackGroupName = _decodeAttackGroup(d.attack_group, d.attack);
        return {
          idx: i,
          timestamp: toNumber(d.timestamp),
          length: toNumber(d.length),
          src_ip: _decodeIp(d.src_ip),
          dst_ip: _decodeIp(d.dst_ip),
          protocol: (d.protocol || '').toUpperCase() || 'OTHER',
          count: toNumber(d.count) || 1,
          attack: attackName,
          attack_group: attackGroupName,
        };
      }).filter(d => {
        // Filter out records with invalid data
        const hasValidTimestamp = isFinite(d.timestamp);
        const hasValidSrcIp = d.src_ip && d.src_ip !== 'N/A' && !d.src_ip.startsWith('IP_');
        const hasValidDstIp = d.dst_ip && d.dst_ip !== 'N/A' && !d.dst_ip.startsWith('IP_');
        return hasValidTimestamp && hasValidSrcIp && hasValidDstIp;
      });

      if (!data.length) {
        setStatus(statusEl,'Default CSV loaded but no valid rows found. Check IP mappings.');
        return;
      }
      
      // Store file info for smart detection (use efficient iteration to avoid stack overflow)
      let minTime = Infinity;
      let maxTime = -Infinity;
      for (let i = 0; i < data.length; i++) {
        const ts = data[i].timestamp;
        if (isFinite(ts)) {
          if (ts < minTime) minTime = ts;
          if (ts > maxTime) maxTime = ts;
        }
      }
      if (minTime === Infinity) minTime = null;
      if (maxTime === -Infinity) maxTime = null;
      const defaultFileName = 'set1_first90_minutes.csv';
      const decodedFileName = mapToDecodedFilename(defaultFileName);
      loadedFileInfo = [{
        fileName: defaultFileName, // Original timearcs filename
        decodedFileName: decodedFileName, // Mapped to Python input filename
        filePath: defaultPath,
        minTime,
        maxTime,
        recordCount: data.length,
        setNumber: detectSetNumber(defaultFileName),
        dayNumber: detectDayNumber(defaultFileName)
      }];
      updateDatasetConfig();
      
      // Report how many rows were filtered out
      const totalRows = rows.length;
      const filteredRows = totalRows - data.length;
      if (filteredRows > 0) {
        setStatus(statusEl,`Loaded default: set1_first90_minutes.csv (${data.length} valid rows, ${filteredRows} filtered due to missing IP mappings)`);
      } else {
        setStatus(statusEl,`Loaded default: set1_first90_minutes.csv (${data.length} rows)`);
      }
      
      render(data);
    } catch (err) {
      // ignore if file isn't present; keep waiting for upload
    }
  }

  function clearChart() {
    // Clear main chart SVG
    svg.selectAll('*').remove();

    // Clear axis SVG
    const axisSvg = d3.select('#axis-top');
    axisSvg.selectAll('*').remove();

    // Clear legend
    legendEl.innerHTML = '';

    // Clear data array to free memory
    if (originalData) {
      originalData.length = 0;
      originalData = null;
    }

    // Clear cached computed data
    if (cachedOriginalLinks) {
      cachedOriginalLinks.length = 0;
      cachedOriginalLinks = null;
    }

    // Clear selection state
    selectedArcs = [];
    selectedIps.clear();
    brushSelection = null;
    selectionTimeRange = null;
    persistentSelections = [];

    // Clear multi-selection group
    if (multiSelectionsGroup) {
      multiSelectionsGroup.selectAll('*').remove();
      multiSelectionsGroup = null;
    }

    // Clear resize handler
    if (resizeCleanup && typeof resizeCleanup === 'function') {
      resizeCleanup();
      resizeCleanup = null;
    }

    console.log('Chart cleared - all SVG elements and data structures released');
  }

  // Use d3 formatters consistently; we prefer UTC to match axis

  // Update label mode without recomputing layout
  function updateLabelMode() {
    if (!cachedOriginalLinks || !currentArcPaths) {
      console.warn('Cannot update label mode - missing data or arcs');
      return;
    }

    const activeLabelKey = labelMode === 'force_layout' ? 'attack_group' : 'attack';
    console.log(`Switching to ${activeLabelKey} label mode (lightweight update)`);

    // Helper to get color for current label mode
    const colorForAttack = (name) => {
      return _lookupAttackColor(name) || _lookupAttackGroupColor(name) || DEFAULT_COLOR;
    };

    // 1. Update arc data attributes (for filtering)
    currentArcPaths.attr('data-attack', d => d[activeLabelKey] || 'normal');

    // 2. Update gradient colors
    svg.selectAll('linearGradient').each(function(d) {
      const grad = d3.select(this);
      grad.select('stop:first-child')
        .attr('stop-color', colorForAttack(d[activeLabelKey] || 'normal'));
    });

    // 3. Rebuild legend with new attack list
    const attacks = Array.from(new Set(cachedOriginalLinks.map(l => l[activeLabelKey] || 'normal'))).sort();

    // Reset visible attacks to show all attacks in new mode
    visibleAttacks.clear();
    attacks.forEach(a => visibleAttacks.add(a));
    currentLabelMode = labelMode;

    buildLegend(attacks, colorForAttack);

    console.log(`Label mode updated: ${attacks.length} ${activeLabelKey} types`);
  }

  // Function to filter data based on visible attacks and re-render
  // Also used by resize handler to re-render current view (filtered or unfiltered)
  async function applyAttackFilter() {
    // In force layout mode, delegate to the force layout instance
    if (layoutMode === 'force_layout' && forceLayout) {
      forceLayout.updateVisibleAttacks(visibleAttacks);
      return;
    }

    if (!originalData || originalData.length === 0) return;

    const activeLabelKey = labelMode === 'force_layout' ? 'attack_group' : 'attack';

    // Get all possible attacks from original data
    const allAttacks = new Set(originalData.map(d => d[activeLabelKey] || 'normal'));

    // If all attacks are visible, render original data without filtering
    if (visibleAttacks.size >= allAttacks.size) {
      render(originalData);
      return;
    }

    // Filter data to only include visible attacks
    const filteredData = originalData.filter(d => {
      const attackName = (d[activeLabelKey] || 'normal');
      return visibleAttacks.has(attackName);
    });

    console.log(`Filtered data: ${filteredData.length} of ${originalData.length} records (${visibleAttacks.size} visible attacks)`);

    // Set flag to prevent overwriting originalData during filtered render
    isRenderingFilteredData = true;
    // Re-render with filtered data (reuses cached layout, skips simulation)
    await render(filteredData);
    // Reset flag after render completes
    isRenderingFilteredData = false;
  }

  // ═══════════════════════════════════════════════════════════
  // Force-directed network layout transitions
  // ═══════════════════════════════════════════════════════════

  async function transitionToForceLayout() {
    if (!_renderLinksWithNodes || _renderLinksWithNodes.length === 0) {
      console.warn('No data available for force layout');
      layoutMode = 'timearcs';
      labelMode = 'timearcs';
      document.getElementById('labelModeTimearcs').checked = true;
      return;
    }

    layoutTransitionInProgress = true;
    setStatus(statusEl, 'Computing force layout...');

    const activeLabelKey = 'attack_group';

    // Use same color priority as timearcs for consistency
    const colorForAttack = (name) => {
      return _lookupAttackColor(name) || _lookupAttackGroupColor(name) || DEFAULT_COLOR;
    };

    // Build initial positions (center X, timearcs Y) for force simulation seed
    const drawWidth = width - MARGIN.left - MARGIN.right;
    const centerX = MARGIN.left + drawWidth / 2;
    const initialPositions = new Map();
    for (const ip of _renderAllIps) {
      const yPos = _renderYScaleLens ? _renderYScaleLens(ip) : MARGIN.top + 50;
      initialPositions.set(ip, { x: centerX, y: yPos });
    }

    // Create force layout and pre-calculate final positions (run simulation to completion)
    forceLayout = new ForceNetworkLayout({
      d3, svg, width, height, margin: MARGIN,
      colorForAttack, tooltip, showTooltip, hideTooltip
    });
    forceLayout.setData(
      _renderLinksWithNodes, _renderAllIps,
      _renderIpToComponent, _renderComponents, activeLabelKey
    );
    forceLayout.aggregateForTimeRange(null);

    // rawPositions: pass to render() so autoFit reproduces the same visual layout
    // visualPositions: where nodes will appear on screen (arc merge targets)
    const { rawPositions, visualPositions } = forceLayout.precalculate(initialPositions);

    setStatus(statusEl, 'Animating to force layout...');

    // --- Phase 1: Animate arcs to precalculated force node positions ---

    svg.selectAll('path.arc').style('pointer-events', 'none');

    function mergeArcTween(d, targetSrcPos, targetTgtPos) {
      const sx0 = d.source.x, sy0 = d.source.y;
      const tx0 = d.target.x, ty0 = d.target.y;
      return function(t) {
        const sx = sx0 + (targetSrcPos.x - sx0) * t;
        const sy = sy0 + (targetSrcPos.y - sy0) * t;
        const tx = tx0 + (targetTgtPos.x - tx0) * t;
        const ty = ty0 + (targetTgtPos.y - ty0) * t;
        const dx = tx - sx, dy = ty - sy;
        const dr = Math.sqrt(dx * dx + dy * dy) / 2 * (1 - t);
        if (dr < 1) return `M${sx},${sy} L${tx},${ty}`;
        return sy < ty
          ? `M${sx},${sy} A${dr},${dr} 0 0,1 ${tx},${ty}`
          : `M${tx},${ty} A${dr},${dr} 0 0,1 ${sx},${sy}`;
      };
    }

    const arcMergeTransition = svg.selectAll('path.arc')
      .transition().duration(800)
      .attrTween('d', function(d) {
        const srcIp = d.sourceNode.name;
        const tgtIp = d.targetNode.name;
        const srcPos = visualPositions.get(srcIp) || { x: centerX, y: MARGIN.top + 50 };
        const tgtPos = visualPositions.get(tgtIp) || { x: centerX, y: MARGIN.top + 100 };
        return mergeArcTween(d, srcPos, tgtPos);
      })
      .style('opacity', 0.3);

    // Fade out row lines, ip labels, component toggles simultaneously
    svg.selectAll('.row-line, .ip-label, defs linearGradient')
      .style('pointer-events', 'none')
      .transition().duration(800)
      .style('opacity', 0);
    svg.selectAll('.component-toggle')
      .style('pointer-events', 'none')
      .transition().duration(800)
      .style('opacity', 0);

    await arcMergeTransition.end().catch(() => {});

    // --- Phase 2: Show pre-positioned force layout (no live simulation animation) ---

    svg.selectAll('path.arc').style('display', 'none');

    forceLayoutLayer = svg.append('g').attr('class', 'force-layout-layer');
    forceLayout.render(forceLayoutLayer, rawPositions, { staticStart: true });

    // Rebuild legend for attack_group mode
    const attacks = Array.from(new Set(
      _renderLinksWithNodes.map(l => l[activeLabelKey] || 'normal')
    )).sort();
    visibleAttacks = new Set(attacks);
    currentLabelMode = labelMode;
    buildLegend(attacks, colorForAttack);

    // Hide compression slider (magnification not applicable in force mode)
    if (compressionSlider) compressionSlider.closest('div').style.display = 'none';

    layoutTransitionInProgress = false;
    setStatus(statusEl, `Force layout: ${_renderAllIps.length} IPs • ${attacks.length} attack groups`);
  }

  // Show force layout directly without animation (used on initial load when force layout is default)
  function showForceLayoutDirectly() {
    if (!_renderLinksWithNodes || _renderLinksWithNodes.length === 0) {
      console.warn('No data available for force layout');
      layoutMode = 'timearcs';
      labelMode = 'timearcs';
      document.getElementById('labelModeTimearcs').checked = true;
      return;
    }

    const activeLabelKey = 'attack_group';
    const colorForAttack = (name) => {
      return _lookupAttackColor(name) || _lookupAttackGroupColor(name) || DEFAULT_COLOR;
    };

    // Build initial positions from timearcs Y
    const drawWidth = width - MARGIN.left - MARGIN.right;
    const centerX = MARGIN.left + drawWidth / 2;
    const initialPositions = new Map();
    for (const ip of _renderAllIps) {
      const yPos = _renderYScaleLens ? _renderYScaleLens(ip) : MARGIN.top + 50;
      initialPositions.set(ip, { x: centerX, y: yPos });
    }

    // Create force layout
    forceLayout = new ForceNetworkLayout({
      d3, svg, width, height, margin: MARGIN,
      colorForAttack, tooltip, showTooltip, hideTooltip
    });
    forceLayout.setData(
      _renderLinksWithNodes, _renderAllIps,
      _renderIpToComponent, _renderComponents, activeLabelKey
    );
    forceLayout.aggregateForTimeRange(null);

    // Hide timearcs elements (arcs, row lines, labels, component toggles)
    svg.selectAll('path.arc').style('display', 'none');
    svg.selectAll('.row-line, .ip-label, defs linearGradient')
      .style('opacity', 0).style('pointer-events', 'none');
    svg.selectAll('.component-toggle')
      .style('opacity', 0).style('pointer-events', 'none');

    // Render force layout with live simulation (nodes animate from initial positions)
    forceLayoutLayer = svg.append('g').attr('class', 'force-layout-layer');
    forceLayout.render(forceLayoutLayer, initialPositions);

    // Rebuild legend for attack_group mode
    const attacks = Array.from(new Set(
      _renderLinksWithNodes.map(l => l[activeLabelKey] || 'normal')
    )).sort();
    visibleAttacks = new Set(attacks);
    currentLabelMode = labelMode;
    buildLegend(attacks, colorForAttack);

    // Hide compression slider
    if (compressionSlider) compressionSlider.closest('div').style.display = 'none';

    setStatus(statusEl, `Force layout: ${_renderAllIps.length} IPs • ${attacks.length} attack groups`);
  }

  async function transitionToTimearcs() {
    layoutTransitionInProgress = true;
    setStatus(statusEl, 'Animating to TimeArcs...');

    // --- Phase 1: Position arcs at force node positions ---

    // Get current visual force node positions (accounting for autoFit transform)
    const forcePositions = forceLayout ? forceLayout.getVisualNodePositions() : new Map();

    // Make arcs visible again, positioned as straight lines at force positions
    svg.selectAll('path.arc')
      .style('display', null)
      .style('pointer-events', 'none')
      .style('opacity', 0.3)
      .attr('d', function(d) {
        const srcIp = d.sourceNode.name;
        const tgtIp = d.targetNode.name;
        const srcPos = forcePositions.get(srcIp) || { x: MARGIN.left, y: MARGIN.top + 50 };
        const tgtPos = forcePositions.get(tgtIp) || { x: MARGIN.left, y: MARGIN.top + 100 };
        // Straight line at force positions (all same-pair arcs overlap)
        return `M${srcPos.x},${srcPos.y} L${tgtPos.x},${tgtPos.y}`;
      });

    // Fade out force layout layer
    if (forceLayoutLayer) {
      forceLayoutLayer
        .transition().duration(600)
        .style('opacity', 0)
        .on('end', function () {
          d3.select(this).remove();
        });
    }

    // Fade in row lines, ip labels, component toggles
    svg.selectAll('.row-line')
      .transition().duration(800)
      .style('opacity', 1)
      .on('end', function () { d3.select(this).style('opacity', null).style('pointer-events', null); });
    svg.selectAll('.ip-label')
      .transition().duration(800)
      .style('opacity', 1)
      .on('end', function () { d3.select(this).style('opacity', null).style('pointer-events', null); });
    svg.selectAll('.component-toggle')
      .transition().duration(800)
      .style('opacity', 1)
      .on('end', function () { d3.select(this).style('pointer-events', null); });

    // --- Phase 2: Animate split — arcs fan out to timearc positions ---

    // Custom split interpolator: straight line at force positions → curved arc at timearc position
    function splitArcTween(d, startSrcPos, startTgtPos, endArcX, endSrcY, endTgtY) {
      return function(t) {
        const sx = startSrcPos.x + (endArcX - startSrcPos.x) * t;
        const sy = startSrcPos.y + (endSrcY - startSrcPos.y) * t;
        const tx = startTgtPos.x + (endArcX - startTgtPos.x) * t;
        const ty = startTgtPos.y + (endTgtY - startTgtPos.y) * t;
        const dx = tx - sx, dy = ty - sy;
        const dr = Math.sqrt(dx * dx + dy * dy) / 2 * t;
        if (dr < 1) return `M${sx},${sy} L${tx},${ty}`;
        return sy < ty
          ? `M${sx},${sy} A${dr},${dr} 0 0,1 ${tx},${ty}`
          : `M${tx},${ty} A${dr},${dr} 0 0,1 ${sx},${sy}`;
      };
    }

    const arcSplitTransition = svg.selectAll('path.arc')
      .transition().duration(800)
      .attrTween('d', function(d) {
        const srcIp = d.sourceNode.name;
        const tgtIp = d.targetNode.name;
        const srcPos = forcePositions.get(srcIp) || { x: MARGIN.left, y: MARGIN.top + 50 };
        const tgtPos = forcePositions.get(tgtIp) || { x: MARGIN.left, y: MARGIN.top + 100 };
        // Target positions: each arc fans to its own time position
        const arcX = _renderXScaleLens ? _renderXScaleLens(d.minute) : MARGIN.left;
        const srcY = _renderYScaleLens ? _renderYScaleLens(srcIp) : MARGIN.top + 50;
        const tgtY = _renderYScaleLens ? _renderYScaleLens(tgtIp) : MARGIN.top + 100;
        return splitArcTween(d, srcPos, tgtPos, arcX, srcY, tgtY);
      })
      .style('opacity', 1);

    // Wait for split animation to complete
    await arcSplitTransition.end().catch(() => {});

    // --- Phase 3: Cleanup ---

    // Destroy force layout instance
    if (forceLayout) {
      forceLayout.destroy();
      forceLayout = null;
    }
    forceLayoutLayer = null;

    // Restore arc pointer-events and clear inline opacity
    svg.selectAll('path.arc')
      .style('pointer-events', null)
      .style('opacity', null);

    // Show compression slider
    if (compressionSlider) compressionSlider.closest('div').style.display = '';

    // Restore timearcs SVG height (may have been deferred during initial force layout load)
    if (cachedDynamicHeight) {
      svg.attr('height', cachedDynamicHeight);
    }

    // Refresh timearcs positions to match current bifocal state
    if (updateBifocalVisualizationFn) {
      updateBifocalVisualizationFn();
    }

    // Rebuild legend for timearcs mode
    if (cachedOriginalLinks) {
      const activeLabelKey = 'attack';
      const attacks = Array.from(new Set(
        cachedOriginalLinks.map(l => l[activeLabelKey] || 'normal')
      )).sort();
      visibleAttacks = new Set(attacks);
      currentLabelMode = labelMode;

      const colorForAttack = (name) => {
        return _lookupAttackColor(name) || _lookupAttackGroupColor(name) || DEFAULT_COLOR;
      };
      buildLegend(attacks, colorForAttack);
    }

    layoutTransitionInProgress = false;
    setStatus(statusEl, 'TimeArcs view restored');
  }

  function buildLegend(items, colorFn) {
    createLegend(legendEl, items, colorFn, visibleAttacks, {
      onToggle: (attackName) => {
        if (visibleAttacks.has(attackName)) {
          visibleAttacks.delete(attackName);
        } else {
          visibleAttacks.add(attackName);
        }
        updateLegendUI(legendEl, visibleAttacks);
        applyAttackFilter(); // Recompute layout with filtered data
      },
      onIsolate: (attackName) => {
        isolateLegendAttack(attackName, visibleAttacks, legendEl);
        updateLegendUI(legendEl, visibleAttacks);
        applyAttackFilter(); // Recompute layout with filtered data
      }
    });
  }

  async function render(data) {
    // Increment generation to cancel any in-flight async render
    const thisGeneration = ++renderGeneration;

    // === CLEANUP: Clear all previous render state before starting ===
    // Clear all SVG elements
    svg.selectAll('*').remove();

    // Clear axis SVG (don't use const to avoid duplicate declaration later)
    d3.select('#axis-top').selectAll('*').remove();

    // Clear selection state arrays to free memory
    selectedArcs = [];
    selectedIps.clear();
    brushSelection = null;
    selectionTimeRange = null;
    persistentSelections = [];

    // Clear resize handler if it exists
    if (resizeCleanup && typeof resizeCleanup === 'function') {
      resizeCleanup();
      resizeCleanup = null;
    }

    // Clear arc paths reference
    currentArcPaths = null;

    // Clear bifocal handles reference so they get recreated (bifocalState is preserved)
    bifocalHandles = null;

    console.log('Render cleanup completed - SVG, axis, and state cleared');
    // === END CLEANUP ===

    // Store original data for filtering and resize (only if this is truly new data, not filtered data)
    // Don't overwrite originalData if we're rendering filtered data
    if (!isRenderingFilteredData && (!originalData || visibleAttacks.size === 0)) {
      originalData = data;
      // Clear cached links and layout since we have new original data
      cachedOriginalLinks = null;
      cachedLayoutResult = null;
      console.log('Stored original data:', originalData.length, 'records');
    }

    // Determine which label dimension we use (attack vs group) for legend and coloring
    const activeLabelKey = labelMode === 'force_layout' ? 'attack_group' : 'attack';

    // Determine timestamp handling
    const tsMin = d3.min(data, d => d.timestamp);
    const tsMax = d3.max(data, d => d.timestamp);
    // Heuristic timestamp unit detection by magnitude:
    // Detect timestamp unit and create converter using factory
    const timeInfo = detectTimestampUnit(tsMin, tsMax);
    const { unit, looksAbsolute, unitMs, unitSuffix, base } = timeInfo;
    const toDate = createToDateConverter(timeInfo);
    
    console.log('Timestamp debug:', {
      tsMin,
      tsMax,
      looksAbsolute,
      inferredUnit: unit,
      base,
      sampleTimestamps: data.slice(0, 5).map(d => d.timestamp)
    });
    
    // Store time info for export function (needs to be accessible outside render scope)
    currentTimeInfo = {
      unit,
      looksAbsolute,
      unitMs,
      unitSuffix,
      base,
      activeLabelKey
    };

    // Aggregate links; then order IPs using the React component's approach:
    // primary-attack grouping, groups ordered by earliest time, nodes within group by force-simulated y
    const links = computeLinks(data); // aggregated per pair per minute
    
    // Collect ALL IPs from links (not just from nodes) to ensure scale includes all referenced IPs
    const allIpsFromLinks = new Set();
    links.forEach(l => {
      allIpsFromLinks.add(l.source);
      allIpsFromLinks.add(l.target);
    });
    
    const nodeData = computeNodesByAttackGrouping(links);
    const nodes = nodeData.nodes;
    const ips = nodes.map(n => n.name);
    const { simNodes, simLinks, yMap, components, ipToComponent } = nodeData;

    // Initialize component expansion state (default: all collapsed)
    if (!isRenderingFilteredData && components && components.length > 1) {
      if (componentExpansionState.size === 0) {
        components.forEach((comp, idx) => {
          componentExpansionState.set(idx, false); // All collapsed by default
        });
        console.log(`Initialized ${components.length} components as collapsed`);
      }
    }

    // Create simulation using the factory function
    const simulation = createForceSimulation(d3, simNodes, simLinks);
    simulation._components = components;
    simulation._ipToComponent = ipToComponent;
    
    // Ensure all IPs from links are included in the initial IP list
    // This prevents misalignment when arcs reference IPs not in the nodes list
    const allIps = Array.from(new Set([...ips, ...allIpsFromLinks]));
    
    console.log('Render debug:', {
      dataLength: data.length,
      linksLength: links.length,
      nodesLength: nodes.length,
      ipsLength: ips.length,
      allIpsLength: allIps.length,
      sampleIps: ips.slice(0, 5),
      sampleLinks: links.slice(0, 3)
    });

    // Build attacks list from ORIGINAL data (not filtered) so legend always shows all attacks
    // Use cached originalLinks if available to avoid recomputing
    if (!cachedOriginalLinks && originalData) {
      // If rendering unfiltered data, reuse already-computed links instead of recomputing
      cachedOriginalLinks = (data === originalData) ? links : computeLinks(originalData);
      console.log('Cached originalLinks:', cachedOriginalLinks.length, 'links',
        data === originalData ? '(reused)' : '(computed)');
    }
    const originalLinks = cachedOriginalLinks || links;
    const attacks = Array.from(new Set(originalLinks.map(l => l[activeLabelKey] || 'normal'))).sort();

    // Only initialize visibleAttacks on first render or when switching label modes
    // This preserves the user's filter selections across re-renders
    if (visibleAttacks.size === 0 || currentLabelMode !== labelMode) {
      visibleAttacks = new Set(attacks);
      console.log('Initialized visibleAttacks with', attacks.length, 'attacks');
    }
    currentLabelMode = labelMode;

    // Sizing based on fixed height (matching main.js: height = 780)
    // main.js uses: height = 780 - MARGIN.top - MARGIN.bottom = 780 (since MARGIN.top=0, MARGIN.bottom=5)
    // Match main.js: use fixed height instead of scaling with number of IPs
    // Fit width to container - like main.js: width accounts for MARGINs
    const availableWidth = container.clientWidth || 1200;
    const viewportWidth = Math.max(availableWidth, 800);
    // Calculate width accounting for MARGINs (like main.js: width = clientWidth - MARGIN.left - MARGIN.right)
    width = viewportWidth - MARGIN.left - MARGIN.right;
    height = MARGIN.top + INNER_HEIGHT + MARGIN.bottom;

    // Initial SVG size - will be updated after calculating actual arc extents
    svg.attr('width', width + MARGIN.left + MARGIN.right)
       .attr('height', height)
       .style('user-select', 'none')  // Prevent text selection during brush drag
       .style('-webkit-user-select', 'none')
       .style('-moz-user-select', 'none')
       .style('-ms-user-select', 'none');

    const xMinDate = toDate(tsMin);
    const xMaxDate = toDate(tsMax);
    
    console.log('X-scale debug:', {
      tsMin,
      tsMax,
      xMinDate,
      xMaxDate,
      xMinValid: isFinite(xMinDate.getTime()),
      xMaxValid: isFinite(xMaxDate.getTime())
    });
    
    // Timeline width is the available width after accounting for left MARGIN offset
    // Like main.js, we use the full width (after MARGINs) for the timeline
    const timelineWidth = width;
    
    console.log('Timeline fitting:', {
      containerWidth: container.clientWidth,
      viewportWidth,
      timelineWidth,
      MARGINLeft: MARGIN.left,
      MARGINRight: MARGIN.right
    });
    
    // X scale for timeline that fits in container
    // Calculate max arc radius to reserve space for arc curves
    const ipIndexMap = new Map(allIps.map((ip, idx) => [ip, idx]));
    let maxIpIndexDist = 0;
    links.forEach(l => {
      const srcIdx = ipIndexMap.get(l.source);
      const tgtIdx = ipIndexMap.get(l.target);
      if (srcIdx !== undefined && tgtIdx !== undefined) {
        const dist = Math.abs(srcIdx - tgtIdx);
        if (dist > maxIpIndexDist) maxIpIndexDist = dist;
      }
    });
    // Estimate final spacing after auto-fit (scalePoint with padding 0.5)
    const estimatedStep = allIps.length > 1 ? INNER_HEIGHT / allIps.length : INNER_HEIGHT;
    const maxArcRadius = (maxIpIndexDist * estimatedStep) / 2;

    const svgWidth = width + MARGIN.left + MARGIN.right;
    const xStart = MARGIN.left;
    const xEnd = svgWidth - MARGIN.right - maxArcRadius;

    const x = createTimeScale(d3, xMinDate, xMaxDate, xStart, xEnd);

    // Track the current xEnd value (will be updated after arc radius calculation)
    let currentXEnd = xEnd;

    // Bifocal-aware x scale function using imported factory
    const xScaleLens = createLensXScale({
      xScale: x,
      tsMin,
      tsMax,
      xStart,
      xEnd: xEnd, // Use initial xEnd, will be updated via getter
      toDate,
      getBifocalEnabled: () => bifocalEnabled,
      getBifocalState: () => bifocalState,
      getXEnd: () => currentXEnd // Dynamic getter for updated xEnd
    });

    // Use allIps for the y scale to ensure all IPs referenced in arcs are included
    const y = createIpScale(d3, allIps, MARGIN.top, MARGIN.top + INNER_HEIGHT, 0.5);
    
    console.log('Y-scale debug:', {
      domain: allIps,
      domainLength: allIps.length,
      sampleYValues: allIps.slice(0, 5).map(ip => ({ ip, y: y(ip) }))
    });

    // Store evenly distributed positions after auto-fit animation
    let evenlyDistributedYPositions = null;
    
    // Y scale function (matching main.js: no vertical lensing, just return y position)
    function yScaleLens(ip) {
      // If we have evenly distributed positions (after animation), use those
      if (evenlyDistributedYPositions && evenlyDistributedYPositions.has(ip)) {
        return evenlyDistributedYPositions.get(ip);
      }
      // Otherwise use the base y scale (matching main.js: no vertical lensing)
      return y(ip);
    }

    // Width scale by aggregated link count (log scale like the React version)
    const minLinkCount = d3.min(links, d => Math.max(1, d.count)) || 1;
    const maxLinkCount = d3.max(links, d => Math.max(1, d.count)) || 1;
    const widthScale = createWidthScale(d3, minLinkCount, maxLinkCount);
    // Keep lengthScale (unused) for completeness
    const maxLen = d3.max(data, d => d.length || 0) || 0;
    const lengthScale = d3.scaleLinear().domain([0, Math.max(1, maxLen)]).range([0.6, 2.2]);

    const colorForAttack = (name) => {
      return _lookupAttackColor(name) || _lookupAttackGroupColor(name) || DEFAULT_COLOR;
    };

    // Clear
    svg.selectAll('*').remove();

    // Axes — render to sticky top SVG
    const axisScale = d3.scaleTime()
      .domain([xMinDate, xMaxDate])
      .range([0, xEnd - xStart]);
    
    const utcTick = d3.utcFormat('%m-%d %H:%M');
    const xAxis = d3.axisTop(axisScale).ticks(looksAbsolute ? 7 : 7).tickFormat(d => {
      if (looksAbsolute) return utcTick(d);
      const relUnits = Math.round((d.getTime()) / unitMs);
      return `t=${relUnits}${unitSuffix}`;
    });
    
    // Create axis SVG that matches the viewport width
    const axisSvg = d3.select('#axis-top')
      .attr('width', width + MARGIN.left + MARGIN.right)
      .attr('height', 36);
    axisSvg.selectAll('*').remove();
    
    // Create axis group
    const axisGroup = axisSvg.append('g')
      .attr('transform', `translate(${xStart}, 28)`)
      .call(xAxis);

    // Utility for safe gradient IDs per link
    // Use original IP strings (sourceIp/targetIp) for gradient IDs
    const gradIdForLink = (d) => gradientIdForLink(d, sanitizeId);

    // Row labels and span lines: draw per-IP line only from first to last activity
    const rows = svg.append('g');
    // compute first/last minute per IP based on aggregated links
    const ipSpans = computeIpSpans(links);
    // Use allIps to ensure all IPs have row lines, matching the labels and arcs
    const spanData = createSpanData(allIps, ipSpans);

    renderRowLines(rows, spanData, MARGIN.left, yScaleLens);

    // Build legend (attack types)
    buildLegend(attacks, colorForAttack);

    // Create node objects for each IP with x/y properties (matching main.js structure)
    // This allows links to reference node objects with x/y coordinates
    const ipToNode = new Map();
    allIps.forEach(ip => {
      const node = { name: ip, x: 0, y: 0 };
      ipToNode.set(ip, node);
    });

    // Transform links to have source/target as node objects (matching main.js)
    // Keep original IP strings for gradient/display purposes
    const linksWithNodes = links.map(link => {
      const sourceNode = ipToNode.get(link.source);
      const targetNode = ipToNode.get(link.target);
      if (!sourceNode || !targetNode) {
        console.warn('Missing node for link:', link);
        return null;
      }
      return {
        ...link,
        // Preserve original IP strings for gradient IDs and other uses
        sourceIp: link.source,
        targetIp: link.target,
        // Store node objects separately
        sourceNode: sourceNode,
        targetNode: targetNode,
        // For linkArc function, use source/target as node objects (will be set per-arc)
        source: sourceNode,
        target: targetNode
      };
    }).filter(l => l !== null);

    // Function to update node positions from scales (called during render/update)
    // Match main.js: nodes maintain their x/y positions and xConnected
    function updateNodePositions() {
      // X position for all labels: first time tick in the timeline
      const firstTimeTickX = xScaleLens(tsMin);
      // Offset labels to the left to avoid touching the first arc
      const labelOffset = 15; // pixels to nudge labels left
      allIps.forEach(ip => {
        const node = ipToNode.get(ip);
        if (node) {
          // Y position comes from the scale (matching main.js n.y)
          node.y = yScaleLens(ip);
          // X position: nudged left of first time tick to avoid arc overlap
          node.xConnected = firstTimeTickX - labelOffset;
        }
      });
    }
    
    // Initialize node positions (matching main.js where nodes have n.y and xConnected)
    updateNodePositions();

    // Create labels for all IPs to ensure alignment with arcs
    // Match main.js: labels positioned at first arc time (xConnected) initially
    // Must be created after nodes are set up and positions are calculated
    const ipLabels = renderIpLabels(rows, allIps, ipToNode, MARGIN.left, yScaleLens);

    // Hide labels for collapsed components
    ipLabels
      .style('opacity', d => {
        const compIdx = ipToComponent.get(d);
        if (compIdx === undefined) return 1; // Single component or no component info
        return componentExpansionState.get(compIdx) === true ? 1 : 0;
      });

    // Render component expansion toggles (only for multi-component layouts)
    let componentToggles = null;
    if (components && components.length > 1) {
      componentToggles = renderComponentToggles(
        rows,
        components,
        ipToComponent,
        yScaleLens,
        MARGIN.left,
        componentExpansionState,
        (compIdx) => {
          // Toggle callback
          const wasExpanded = componentExpansionState.get(compIdx) === true;
          componentExpansionState.set(compIdx, !wasExpanded);
          console.log(`Component ${compIdx} ${wasExpanded ? 'collapsed' : 'expanded'}`);

          // Update toggle visual immediately
          updateComponentToggles(componentToggles, componentExpansionState);

          // Re-render with new spacing
          applyComponentLayout();
        },
        (compIdx) => {
          // Export CSV callback for this component
          exportComponentCSV(compIdx, components, ipToComponent, linksWithNodes, data);
        }
      );
    }

    // Create per-link gradients from grey (source) to attack color (destination)
    const defs = svg.append('defs');

    const gradients = defs.selectAll('linearGradient')
      .data(linksWithNodes)
      .join('linearGradient')
      .attr('id', d => gradIdForLink(d))
      .attr('gradientUnits', 'userSpaceOnUse')
      .attr('x1', d => xScaleLens(d.minute))
      .attr('x2', d => xScaleLens(d.minute))
      .attr('y1', d => yScaleLens(d.sourceNode.name))
      .attr('y2', d => yScaleLens(d.targetNode.name));

    gradients.each(function(d) {
      const g = d3.select(this);
      // Reset stops to avoid duplicates on re-renders
      g.selectAll('stop').remove();
      g.append('stop')
        .attr('offset', '0%')
        .attr('stop-color', colorForAttack((labelMode==='force_layout'? d.attack_group : d.attack) || 'normal'));
      g.append('stop')
        .attr('offset', '100%')
        .attr('stop-color', NEUTRAL_GREY);
    });

    // Draw arcs using linkArc function (matching main.js)
    const arcs = svg.append('g');
    const arcPaths = arcs.selectAll('path')
      .data(linksWithNodes)
      .join('path')
      .attr('class', 'arc')
      .attr('data-attack', d => (labelMode === 'force_layout' ? d.attack_group : d.attack) || 'normal')
      .attr('stroke', d => `url(#${gradIdForLink(d)})`)
      .attr('stroke-width', d => widthScale(Math.max(1, d.count)))
      .attr('d', d => {
        // Update node positions for this link (matching main.js pattern)
        // In main.js, nodes have x/y from force layout; here we compute from scales
        const xp = xScaleLens(d.minute);
        const y1 = yScaleLens(d.sourceNode.name);
        const y2 = yScaleLens(d.targetNode.name);

        // Validate coordinates
        if (xp === undefined || !isFinite(xp) || y1 === undefined || !isFinite(y1) || y2 === undefined || !isFinite(y2)) {
          console.warn('Invalid coordinates for arc:', {
            minute: d.minute,
            source: d.sourceNode.name,
            target: d.targetNode.name,
            xp, y1, y2
          });
          return 'M0,0 L0,0';
        }

        // Set node positions for linkArc function (matching main.js)
        // All arcs at the same time share the same x position
        d.source.x = xp;
        d.source.y = y1;
        d.target.x = xp;
        d.target.y = y2;

        return linkArc(d);
      });

    // Create arc interaction handlers using factory functions
    const arcHoverHandler = createArcHoverHandler({
      arcPaths,
      svg,
      ipToNode,
      widthScale,
      xScaleLens: (m) => xScaleLens(m),
      yScaleLens: (ip) => yScaleLens(ip),
      colorForAttack,
      showTooltip: (evt, html) => showTooltip(tooltip, evt, html),
      getLabelMode: () => labelMode,
      toDate,
      timeFormatter: utcTick,
      looksAbsolute,
      unitSuffix,
      base,
      getLabelsCompressedMode: () => labelsCompressedMode,
      marginLeft: MARGIN.left,
      ipToComponent,
      getComponentExpansionState: () => componentExpansionState
    });

    const arcMoveHandler = createArcMoveHandler({ tooltip });

    const arcLeaveHandler = createArcLeaveHandler({
      arcPaths,
      svg,
      ipToNode,
      widthScale,
      hideTooltip: () => hideTooltip(tooltip),
      yScaleLens: (ip) => yScaleLens(ip),
      getLabelsCompressedMode: () => labelsCompressedMode,
      marginLeft: MARGIN.left,
      ipToComponent,
      getComponentExpansionState: () => componentExpansionState
    });

    attachArcHandlers(arcPaths, arcHoverHandler, arcMoveHandler, arcLeaveHandler);

    // Store arcPaths reference for legend filtering (after all handlers are attached)
    currentArcPaths = arcPaths;

    // Setup brush selection for data extraction with drag-to-brush behavior
    // User can click and drag anywhere to select - no toggle needed
    let brushGroup = null;
    let brush = null;

    const setupDragToBrush = () => {
      if (brushGroup) return; // Already set up

      // Create brush
      brush = d3.brush()
        .extent([[MARGIN.left, MARGIN.top], [width + MARGIN.left, MARGIN.top + INNER_HEIGHT]])
        .on('start', function(event) {
          updateBrushStatus('Selecting...', true);
        })
        .on('brush', function(event) {
          if (!event.selection) return;
          const [[x0, y0], [x1, y1]] = event.selection;
          brushSelection = { x0, y0, x1, y1 };
          // No preview calculation - show result after drag completes
        })
        .on('end', function(event) {
          // The brush 'end' event fires when:
          // 1. User clears the brush (clicks outside selection)
          // 2. brush.move(null) is called
          // Note: Selection processing is handled by finalizeBrushSelection in mouseup.dragbrush

          // Disable brush overlay pointer events
          if (brushGroup) {
            brushGroup.select('.overlay').style('pointer-events', 'none');
          }

          if (!event.selection) {
            // Brush was cleared - update status but don't clear persistent selections
            brushSelection = null;
            // Only reset current selection state, not persistent selections
            selectedArcs = [];
            selectedIps.clear();
            selectionTimeRange = null;

            // Update status based on whether there are persistent selections
            if (persistentSelections.length > 0) {
              updateBrushStatus(`${persistentSelections.length} selection${persistentSelections.length > 1 ? 's' : ''} saved`, false);
            } else {
              updateBrushStatus('Drag to select', false);
            }
          }
        });

      brushGroup = svg.append('g')
        .attr('class', 'brush-group')
        .call(brush);

      // Style brush
      brushGroup.selectAll('.selection')
        .style('fill', '#007bff')
        .style('fill-opacity', 0.15)
        .style('stroke', '#007bff')
        .style('stroke-width', 2)
        .style('stroke-dasharray', '5,5');

      // CRITICAL: Disable pointer events on overlay initially
      // This allows hover events on arcs to work normally
      brushGroup.select('.overlay').style('pointer-events', 'none');

      // Create group for persistent selections (below brush group)
      if (!multiSelectionsGroup) {
        multiSelectionsGroup = svg.insert('g', '.brush-group')
          .attr('class', 'multi-selections-group');
      }

      // Add drag detection handlers to SVG for drag-to-brush
      // This allows hover to work normally, but click+drag starts brush selection
      svg.on('mousedown.dragbrush', function(event) {
        // In force layout mode, skip if clicking on force nodes (let d3.drag handle those)
        if (layoutMode === 'force_layout' && event.target.closest('.force-node')) return;
        // Ignore if clicking on persistent selection elements
        if (event.target.closest('.persistent-selection')) return;
        // Ignore if clicking on brush handles (for resizing existing selection)
        if (event.target.closest('.brush-group .handle')) return;
        // Ignore right-click
        if (event.button !== 0) return;

        // Allow drag detection to start anywhere, including on arcs
        // If user drags > threshold, we'll start brush selection
        // If user just clicks (< threshold), arc interactions still work

        dragStart = d3.pointer(event, this);
        isDragging = false;
      });

      svg.on('mousemove.dragbrush', function(event) {
        if (!dragStart) return;

        const current = d3.pointer(event, this);
        const distance = Math.hypot(current[0] - dragStart[0], current[1] - dragStart[1]);

        if (!isDragging && distance > DRAG_THRESHOLD) {
          isDragging = true;
          console.log('Drag threshold exceeded, starting brush selection');

          // Prevent default behavior NOW that we know it's a drag
          event.preventDefault();

          // Disable pointer events on arcs to prevent hover/selection during brush
          arcPaths.style('pointer-events', 'none');

          // Enable brush overlay pointer events
          brushGroup.select('.overlay').style('pointer-events', 'all');
        }

        // If dragging, prevent default and set the brush selection
        if (isDragging) {
          // Continue preventing text selection during drag
          event.preventDefault();

          // Calculate selection bounds from drag start to current position
          const x0 = Math.min(dragStart[0], current[0]);
          const y0 = Math.min(dragStart[1], current[1]);
          const x1 = Math.max(dragStart[0], current[0]);
          const y1 = Math.max(dragStart[1], current[1]);

          // Use brush.move to set the selection programmatically
          brushGroup.call(brush.move, [[x0, y0], [x1, y1]]);
        }
      });

      svg.on('mouseup.dragbrush', function(event) {
        if (isDragging && dragStart) {
          // Finalize the brush selection
          const current = d3.pointer(event, this);
          const x0 = Math.min(dragStart[0], current[0]);
          const y0 = Math.min(dragStart[1], current[1]);
          const x1 = Math.max(dragStart[0], current[0]);
          const y1 = Math.max(dragStart[1], current[1]);

          // Process the selection
          finalizeBrushSelection(x0, y0, x1, y1);

          // Clear the brush visual and disable pointer events
          brushGroup.call(brush.move, null);
          brushGroup.select('.overlay').style('pointer-events', 'none');

          // Re-enable pointer events on arcs after brush ends
          arcPaths.style('pointer-events', null);
        }
        dragStart = null;
        isDragging = false;
      });

      svg.on('mouseleave.dragbrush', function() {
        // Cancel drag detection if mouse leaves SVG
        if (isDragging) {
          // Re-enable pointer events on arcs if drag was in progress
          arcPaths.style('pointer-events', null);
        }
        if (dragStart) {
          dragStart = null;
        }
        isDragging = false;
      });
    };

    // Finalize brush selection - called when drag ends
    const finalizeBrushSelection = (x0, y0, x1, y1) => {
      console.log('Finalizing brush selection:', { x0, y0, x1, y1 });

      // Force layout mode: select nodes within brush rectangle
      if (layoutMode === 'force_layout' && forceLayout) {
        const nodePositions = forceLayout.getVisualNodePositions();
        selectedArcs = [];
        selectedIps.clear();

        for (const [ip, pos] of nodePositions) {
          if (pos.x >= x0 && pos.x <= x1 && pos.y >= y0 && pos.y <= y1) {
            selectedIps.add(ip);
          }
        }

        if (selectedIps.size > 0) {
          // Collect arcs between selected IPs and compute time range from them
          let minTime = Infinity, maxTime = -Infinity;
          linksWithNodes.forEach(link => {
            if (selectedIps.has(link.sourceNode.name) && selectedIps.has(link.targetNode.name)) {
              selectedArcs.push(link);
              if (link.minute < minTime) minTime = link.minute;
              if (link.minute > maxTime) maxTime = link.minute;
            }
          });

          if (minTime === maxTime) {
            selectionTimeRange = { min: minTime, max: minTime + 1 };
          } else {
            selectionTimeRange = { min: minTime, max: maxTime + 1 };
          }

          const selectionId = ++selectionIdCounter;
          const persistedSelection = {
            id: selectionId,
            timeBounds: { minTime, maxTime, minY: y0, maxY: y1 },
            pixelBounds: { x0, y0, x1, y1 },
            arcs: [...selectedArcs],
            ips: new Set(selectedIps),
            timeRange: { ...selectionTimeRange }
          };
          persistentSelections.push(persistedSelection);

          createPersistentSelectionVisual(persistedSelection);
          updateSelectionDisplay();
          updateBrushStatus(`${persistentSelections.length} selection${persistentSelections.length > 1 ? 's' : ''} saved`, false);
        } else {
          selectionTimeRange = null;
          updateBrushStatus('No nodes selected', false);
          setTimeout(() => updateBrushStatus('Drag to select', false), 1500);
        }
        return;
      }

      // Timearcs mode: find arcs within brush selection
      selectedArcs = [];
      selectedIps.clear();
      let minTime = Infinity;
      let maxTime = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;

      linksWithNodes.forEach(link => {
        const xp = xScaleLens(link.minute);
        const arcSourceY = yScaleLens(link.sourceNode.name);
        const arcTargetY = yScaleLens(link.targetNode.name);

        const xIntersects = xp >= x0 && xp <= x1;
        const sourceInBrush = arcSourceY >= y0 && arcSourceY <= y1;
        const targetInBrush = arcTargetY >= y0 && arcTargetY <= y1;
        const yIntersects = sourceInBrush && targetInBrush;

        if (xIntersects && yIntersects) {
          selectedArcs.push(link);
          selectedIps.add(link.sourceNode.name);
          selectedIps.add(link.targetNode.name);

          if (link.minute < minTime) minTime = link.minute;
          if (link.minute > maxTime) maxTime = link.minute;

          // Track Y bounds based on IP positions (not arc positions)
          const srcY = yScaleLens(link.sourceNode.name);
          const dstY = yScaleLens(link.targetNode.name);
          minY = Math.min(minY, srcY, dstY);
          maxY = Math.max(maxY, srcY, dstY);
        }
      });

      // Compute time range
      if (selectedArcs.length > 0) {
        if (minTime === maxTime) {
          selectionTimeRange = { min: minTime, max: minTime + 1 };
        } else {
          selectionTimeRange = { min: minTime, max: maxTime + 1 };
        }

        console.log('Brush selection:', {
          arcs: selectedArcs.length,
          ips: selectedIps.size,
          timeRange: selectionTimeRange
        });

        // Persist this selection with time-based bounds
        const selectionId = ++selectionIdCounter;
        const persistedSelection = {
          id: selectionId,
          // Store time and IP-based bounds instead of pixel bounds
          timeBounds: { minTime, maxTime, minY, maxY },
          arcs: [...selectedArcs],
          ips: new Set(selectedIps),
          timeRange: { ...selectionTimeRange }
        };
        persistentSelections.push(persistedSelection);

        // Create visual representation
        createPersistentSelectionVisual(persistedSelection);

        // Update display and status
        updateSelectionDisplay();
        updateBrushStatus(`${persistentSelections.length} selection${persistentSelections.length > 1 ? 's' : ''} saved`, false);
      } else {
        // No arcs selected
        selectionTimeRange = null;
        updateBrushStatus('No arcs selected', false);
        setTimeout(() => updateBrushStatus('Drag to select', false), 1500);
      }
    };

    // Legacy enableBrushFn for backwards compatibility (now just calls setupDragToBrush)
    const enableBrushFn = () => {
      setupDragToBrush();
    };

    // Create visual representation for a persistent selection
    const createPersistentSelectionVisual = (selection) => {
      if (!multiSelectionsGroup) return;

      const { id, timeBounds, arcs, ips, pixelBounds } = selection;

      let x0, x1, y0, y1;
      if (pixelBounds) {
        // Force layout: use stored pixel bounds directly
        ({ x0, y0, x1, y1 } = pixelBounds);
      } else {
        // Timearcs: convert time bounds to pixel positions
        const { minTime, maxTime, minY, maxY } = timeBounds;
        x0 = xScaleLens(minTime);
        x1 = xScaleLens(maxTime);
        y0 = minY;
        y1 = maxY;
      }

      // Create a group for this selection
      const selGroup = multiSelectionsGroup.append('g')
        .attr('class', `persistent-selection selection-${id}`)
        .attr('data-selection-id', id);

      // Draw the selection rectangle
      selGroup.append('rect')
        .attr('class', 'selection-rect')
        .attr('x', x0)
        .attr('y', y0)
        .attr('width', Math.max(1, x1 - x0))
        .attr('height', Math.max(1, y1 - y0))
        .style('fill', '#28a745')
        .style('fill-opacity', 0.1)
        .style('stroke', '#28a745')
        .style('stroke-width', 2)
        .style('stroke-dasharray', '5,5');

      // Add selection label
      selGroup.append('text')
        .attr('class', 'selection-label')
        .attr('x', x0 + 5)
        .attr('y', y0 + 14)
        .style('font-size', '10px')
        .style('font-weight', '600')
        .style('fill', '#28a745')
        .text(`#${id}: ${arcs.length} arcs, ${ips.size} IPs`);

      // Create button container using foreignObject
      const btnContainer = selGroup.append('foreignObject')
        .attr('class', 'selection-buttons')
        .attr('x', x1 + 5)
        .attr('y', y0)
        .attr('width', 120)
        .attr('height', 60)
        .style('pointer-events', 'all');

      const btnDiv = btnContainer.append('xhtml:div')
        .style('display', 'flex')
        .style('flex-direction', 'column')
        .style('gap', '4px');

      // View Details button
      btnDiv.append('xhtml:button')
        .style('padding', '4px 8px')
        .style('border', '1px solid #28a745')
        .style('border-radius', '4px')
        .style('background', '#28a745')
        .style('color', '#fff')
        .style('cursor', 'pointer')
        .style('font-size', '11px')
        .style('font-weight', '600')
        .style('font-family', 'inherit')
        .text('View Details')
        .on('click', function(event) {
          event.stopPropagation();
          openDetailsInNewTab(selection);
        })
        .on('mouseenter', function() {
          d3.select(this).style('background', '#218838');
        })
        .on('mouseleave', function() {
          d3.select(this).style('background', '#28a745');
        });

      // Delete button
      btnDiv.append('xhtml:button')
        .style('padding', '4px 8px')
        .style('border', '1px solid #dc3545')
        .style('border-radius', '4px')
        .style('background', '#fff')
        .style('color', '#dc3545')
        .style('cursor', 'pointer')
        .style('font-size', '11px')
        .style('font-weight', '600')
        .style('font-family', 'inherit')
        .text('Remove')
        .on('click', function(event) {
          event.stopPropagation();
          removePersistentSelection(id);
        })
        .on('mouseenter', function() {
          d3.select(this).style('background', '#dc3545').style('color', '#fff');
        })
        .on('mouseleave', function() {
          d3.select(this).style('background', '#fff').style('color', '#dc3545');
        });

      console.log(`Created persistent selection #${id}`);
    };

    // Remove a persistent selection
    const removePersistentSelection = (id) => {
      // Remove from array
      persistentSelections = persistentSelections.filter(s => s.id !== id);

      // Remove visual
      if (multiSelectionsGroup) {
        multiSelectionsGroup.select(`.selection-${id}`).remove();
      }

      // Update arc highlighting
      updateSelectionDisplay();

      // Update brush status count
      if (persistentSelections.length > 0) {
        updateBrushStatus(`${persistentSelections.length} selection${persistentSelections.length > 1 ? 's' : ''} saved`, false);
      } else {
        updateBrushStatus('Drag to select', false);
      }

      console.log(`Removed persistent selection #${id}, ${persistentSelections.length} remaining`);
    };

    // Update all persistent selection visuals when scale changes (bifocal)
    const updatePersistentSelectionVisuals = () => {
      if (!multiSelectionsGroup) return;

      persistentSelections.forEach(selection => {
        const { id, timeBounds, pixelBounds } = selection;

        let x0, x1, y0, y1;
        if (pixelBounds) {
          ({ x0, y0, x1, y1 } = pixelBounds);
        } else {
          const { minTime, maxTime, minY, maxY } = timeBounds;
          x0 = xScaleLens(minTime);
          x1 = xScaleLens(maxTime);
          y0 = minY;
          y1 = maxY;
        }

        const selGroup = multiSelectionsGroup.select(`.selection-${id}`);
        if (selGroup.empty()) return;

        // Update rectangle position and size
        selGroup.select('.selection-rect')
          .attr('x', x0)
          .attr('y', y0)
          .attr('width', Math.max(1, x1 - x0))
          .attr('height', Math.max(1, y1 - y0));

        // Update label position
        selGroup.select('.selection-label')
          .attr('x', x0 + 5)
          .attr('y', y0 + 14);

        // Update button container position
        selGroup.select('.selection-buttons')
          .attr('x', x1 + 5)
          .attr('y', y0);
      });
    };

    const disableBrushFn = () => {
      // With drag-to-brush, we don't hide the brush, just ensure overlay is disabled
      if (brushGroup) {
        brushGroup.select('.overlay').style('pointer-events', 'none');
        brushGroup.call(brush.move, null);
        brushSelection = null;
        selectedArcs = [];
        selectedIps.clear();
        selectionTimeRange = null;
        updateSelectionDisplay();
        updateBrushStatus('Drag to select', false);
      }
    };

    const clearBrushSelectionFn = () => {
      // Clear current brush
      if (brush && brushGroup) {
        brushGroup.call(brush.move, null);
      }
      // Clear all persistent selections
      persistentSelections = [];
      if (multiSelectionsGroup) {
        multiSelectionsGroup.selectAll('.persistent-selection').remove();
      }
      // Reset state
      brushSelection = null;
      selectedArcs = [];
      selectedIps.clear();
      selectionTimeRange = null;
      // Reset arc highlighting
      updateSelectionDisplay();
      updateBrushStatus('Drag to select', false);
    };

    const updateSelectionDisplay = () => {
      // Collect all selected arcs from persistent selections
      const allPersistentArcs = persistentSelections.flatMap(s => s.arcs);
      const hasSelection = selectedArcs.length > 0 || allPersistentArcs.length > 0;

      // Highlight selected arcs by making them thicker (no opacity change)
      if (hasSelection) {
        arcPaths.attr('stroke-width', d => {
          const isInCurrent = selectedArcs.some(sel =>
            sel.sourceNode.name === d.sourceNode.name &&
            sel.targetNode.name === d.targetNode.name &&
            sel.minute === d.minute
          );
          const isInPersistent = allPersistentArcs.some(sel =>
            sel.sourceNode.name === d.sourceNode.name &&
            sel.targetNode.name === d.targetNode.name &&
            sel.minute === d.minute
          );
          if (isInCurrent || isInPersistent) {
            const baseW = widthScale(Math.max(1, d.count));
            return Math.max(3, baseW < 2 ? baseW * 2.5 : baseW * 1.5);
          }
          return widthScale(Math.max(1, d.count));
        });

        // Update status with selection info
        let statusText = '';
        if (selectedArcs.length > 0 && selectionTimeRange) {
          const fileDetection = getFilesForTimeRange(selectionTimeRange.min, selectionTimeRange.max);
          const fileInfo = fileDetection.detected
            ? ` (${fileDetection.files.length} file${fileDetection.files.length > 1 ? 's' : ''})`
            : '';
          statusText = `Current: ${selectedArcs.length} arcs, ${selectedIps.size} IPs${fileInfo}`;
        }
        if (persistentSelections.length > 0) {
          const totalArcs = allPersistentArcs.length;
          const totalIPs = new Set(persistentSelections.flatMap(s => Array.from(s.ips))).size;
          statusText += statusText ? ' | ' : '';
          statusText += `${persistentSelections.length} saved selection${persistentSelections.length > 1 ? 's' : ''}: ${totalArcs} arcs, ${totalIPs} IPs`;
        }
        setStatus(statusEl, statusText || 'Draw brush selections to analyze');
      } else {
        // Restore default stroke width (opacity stays at 0.6, no change needed)
        arcPaths.attr('stroke-width', d => widthScale(Math.max(1, d.count)));
        // Clear status message when no selections - show record count if data is loaded
        if (originalData && originalData.length > 0) {
          setStatus(statusEl, `Loaded ${originalData.length} records`);
        } else {
          setStatus(statusEl, 'Waiting for data…');
        }
      }
    };

    // Open ip_bar_diagram.html in a new tab with the selected data
    const openDetailsInNewTab = (selection) => {
      // Use the passed selection or fall back to current selection (for backwards compatibility)
      const selArcs = selection ? selection.arcs : selectedArcs;
      const selIps = selection ? selection.ips : selectedIps;
      const selTimeRange = selection ? selection.timeRange : selectionTimeRange;
      const selId = selection ? selection.id : 0;

      if (!selArcs || selArcs.length === 0) {
        alert('No arcs in selection.');
        return;
      }

      if (!currentTimeInfo) {
        alert('Time information not available. Please load data first.');
        return;
      }

      const { unit, looksAbsolute, unitMs, base, activeLabelKey } = currentTimeInfo;

      // Calculate time range in microseconds for filtering
      let timeStartUs, timeEndUs;
      if (looksAbsolute) {
        if (unit === 'microseconds') {
          timeStartUs = Math.floor(selTimeRange.min);
          timeEndUs = Math.ceil(selTimeRange.max);
        } else if (unit === 'milliseconds') {
          timeStartUs = Math.floor(selTimeRange.min * 1000);
          timeEndUs = Math.ceil(selTimeRange.max * 1000);
        } else if (unit === 'seconds') {
          timeStartUs = Math.floor(selTimeRange.min * 1_000_000);
          timeEndUs = Math.ceil(selTimeRange.max * 1_000_000);
        } else if (unit === 'minutes') {
          timeStartUs = Math.floor(selTimeRange.min * 60_000_000);
          timeEndUs = Math.ceil(selTimeRange.max * 60_000_000);
        } else {
          timeStartUs = Math.floor(selTimeRange.min * 3_600_000_000);
          timeEndUs = Math.ceil(selTimeRange.max * 3_600_000_000);
        }
      } else {
        const baseMs = base * unitMs;
        timeStartUs = Math.floor((baseMs + selTimeRange.min * unitMs) * 1000);
        timeEndUs = Math.ceil((baseMs + selTimeRange.max * unitMs) * 1000);
      }

      // Get primary attack type
      const attackCounts = new Map();
      selArcs.forEach(arc => {
        const attack = arc[activeLabelKey] || 'normal';
        attackCounts.set(attack, (attackCounts.get(attack) || 0) + 1);
      });
      let primaryAttack = 'normal';
      let maxCount = 0;
      attackCounts.forEach((count, attack) => {
        if (count > maxCount) {
          maxCount = count;
          primaryAttack = attack;
        }
      });

      // Generate unique key for this selection to support multiple tabs
      const storageKey = `timearcs_brush_selection_${Date.now()}_${selId}`;

      // Prepare data for ip_bar_diagram
      // Filter currentSortedIps to only include selected IPs, preserving vertical order
      const selIpsSet = selIps instanceof Set ? selIps : new Set(selIps);
      const orderedSelectedIps = currentSortedIps.filter(ip => selIpsSet.has(ip));

      // Get files covering the selection time range
      const fileDetection = getFilesForTimeRange(selTimeRange.min, selTimeRange.max);

      // Build dataFiles array from detected files or all loaded files
      const dataFiles = fileDetection.detected
        ? fileDetection.files
        : (datasetConfig.sets || []).map(s => s.decodedFileName || s.fileName);

      // Get file paths for loading (use filePath from sets if available)
      const filePaths = (datasetConfig.sets || []).map(s => s.filePath).filter(Boolean);

      const selectionData = {
        source: 'attack_timearcs_brush_selection',
        timestamp: Date.now(),
        selectionId: selId,
        selection: {
          ips: Array.from(selIps),
          ipsInOrder: orderedSelectedIps, // IPs in vertical order from TimeArcs
          arcs: selArcs.length,
          timeRange: {
            min: selTimeRange.min,
            max: selTimeRange.max,
            minUs: timeStartUs,
            maxUs: timeEndUs,
            unit: unit
          },
          primaryAttack: primaryAttack,
          attackDistribution: Object.fromEntries(attackCounts)
        },
        dataFiles: dataFiles,
        filePaths: filePaths,
        baseDataPath: datasetConfig.baseDataPath || './',
        // Path to multi-resolution data for ip_bar_diagram (compatible format)
        detailViewDataPath: datasetConfig.detailViewDataPath || null,
        ipMapPath: datasetConfig.ipMapPath || null
      };

      // Store in localStorage for the new tab to read
      // Note: Using localStorage instead of sessionStorage because sessionStorage is tab-scoped
      // and doesn't persist when opening a new tab with window.open()
      try {
        localStorage.setItem(storageKey, JSON.stringify(selectionData));
        console.log(`Stored brush selection #${selId} data for ip_bar_diagram:`, selectionData);
        console.log(`localStorage key: ${storageKey}`);
      } catch (e) {
        console.error('Failed to store selection data:', e);
        alert('Failed to store selection data. The data might be too large.');
        return;
      }

      // Open ip_bar_diagram in a new tab with the storage key as parameter
      // The page will read the fromSelection parameter to get data from localStorage
      const encodedKey = encodeURIComponent(storageKey);
      const newTabUrl = `./ip_bar_diagram.html?fromSelection=${encodedKey}`;

      console.log(`Opening ip_bar_diagram with URL: ${newTabUrl}`);
      console.log(`Full URL will be: ${new URL(newTabUrl, window.location.href).href}`);

      const newWindow = window.open(newTabUrl, '_blank');
      if (!newWindow) {
        // Popup might be blocked, try alternative approach
        console.warn('Popup blocked, trying location navigation');
        alert('Popup was blocked. Please allow popups for this site, or use Ctrl+Click on the View Details button.');
      }
    };


    // Make functions globally accessible for button handlers
    window.enableBrushFn = enableBrushFn;
    window.disableBrushFn = disableBrushFn;
    window.clearBrushSelectionFn = clearBrushSelectionFn;

    // Always set up drag-to-brush (no toggle needed - users drag to select)
    setupDragToBrush();

    // Add hover handlers to IP labels to highlight connected arcs
    const labelHoverHandler = createLabelHoverHandler({
      linksWithNodes,
      arcPaths,
      svg,
      widthScale,
      showTooltip,
      tooltip,
      ipToComponent,
      getComponentExpansionState: () => componentExpansionState
    });
    const labelMoveHandler = createLabelMoveHandler(tooltip);
    const labelLeaveHandler = createLabelLeaveHandler({
      arcPaths,
      svg,
      widthScale,
      hideTooltip,
      tooltip,
      ipToComponent,
      getComponentExpansionState: () => componentExpansionState
    });
    attachLabelHoverHandlers(ipLabels, labelHoverHandler, labelMoveHandler, labelLeaveHandler);

    // When force layout is the default, show it immediately — before the
    // timearcs simulation which has async awaits that yield to the browser
    // and would cause a flash of the timearcs layout.
    if (layoutMode === 'force_layout' && !forceLayout) {
      _renderLinksWithNodes = linksWithNodes;
      _renderAllIps = allIps;
      _renderIpToComponent = ipToComponent;
      _renderComponents = components;
      _renderYScaleLens = yScaleLens;
      _renderXScaleLens = xScaleLens;
      _renderXStart = xStart;
      _renderColorForAttack = colorForAttack;
      _renderTsMin = tsMin;
      _renderTsMax = tsMax;
      showForceLayoutDirectly();
    }

    // Phase 1: Run force simulation for natural clustering with component separation
    // Skip simulation on filtered re-renders — reuse cached IP ordering
    const canReuseCachedLayout = isRenderingFilteredData && cachedLayoutResult;
    if (canReuseCachedLayout) {
      console.log('Reusing cached layout for filtered render');
    }
    setStatus(statusEl,'Stabilizing network layout...');
    
    // Run simulation to completion immediately (not visually)
    const centerX = (MARGIN.left + width - MARGIN.right) / 2;

    if (!canReuseCachedLayout) {
    // --- BEGIN: Full simulation (only for new data) ---
    
    // Calculate degree (number of connections) for each IP from links using imported function
    const ipDegree = calculateIpDegrees(linksWithNodes);

    // Calculate connection strength (weighted by link counts) for pulling hubs together
    const connectionStrength = calculateConnectionStrength(linksWithNodes);

    // Find hub IPs using imported function
    const componentHubIps = findComponentHubIps(components, ipDegree);
    componentHubIps.forEach((hubIp, compIdx) => {
      console.log(`Component ${compIdx} hub IP: ${hubIp} (degree: ${ipDegree.get(hubIp) || 0})`);
    });

    // Initialize nodes based on component membership for better separation
    if (components.length > 1) {
      console.log(`Applying force layout separation for ${components.length} components`);
      
      // Calculate component centers using imported function
      const componentSpacing = INNER_HEIGHT / components.length;
      
      // Log component sizes for debugging
      components.forEach((comp, idx) => {
        console.log(`Component ${idx}: ${comp.length} nodes`);
      });
      
      // Calculate target Y positions for each component center
      const componentCenters = calculateComponentCenters(components, MARGIN.top, INNER_HEIGHT);
      
      // Initialize node positions using imported function
      initializeNodePositions(simNodes, ipToComponent, componentCenters, centerX, ipDegree, componentSpacing);
      
      // Stage 1: Strong component separation - push components apart
      // Use the Y force from the imported function
      simulation.force('y', createComponentYForce(d3, ipToComponent, componentCenters, MARGIN.top + INNER_HEIGHT / 2));
      
      // Use imported force functions with strengthened parameters
      const componentSeparationForce = createComponentSeparationForce(ipToComponent, simNodes, {
        separationStrength: 1.8,  // Increased from default 1.2
        minDistance: 100          // Increased from default 80
      });
      const componentCohesionForce = createComponentCohesionForce(ipToComponent, simNodes);
      const hubCenteringForce = createHubCenteringForce(componentHubIps, componentCenters, simNodes);

      // Mutual hub attraction: pull IPs with most connections together
      const hubAttractionForce = createMutualHubAttractionForce(
        ipToComponent,
        connectionStrength,
        simNodes,
        {
          attractionStrength: 0.8,  // Strength of mutual attraction
          hubThreshold: 0.3         // IPs with >30% of max connection strength are hubs
        }
      );

      // Register the custom forces with the simulation
      simulation.force('componentSeparation', componentSeparationForce);
      simulation.force('componentCohesion', componentCohesionForce);
      simulation.force('hubCentering', hubCenteringForce);
      simulation.force('hubAttraction', hubAttractionForce);

      // Stage 1: Run simulation with strong component separation
      simulation.alpha(0.4).restart();  // Increased from 0.3 for stronger force application
      await runUntilConverged(simulation, 350, 0.001);  // Increased from 300 for better convergence
      if (thisGeneration !== renderGeneration) return; // Stale render cancelled

      // Stage 2: Reduce component forces and allow internal optimization
      simulation.force('y').strength(0.4); // Reduce Y force strength
      simulation.force('componentSeparation', createWeakComponentSeparationForce(ipToComponent, simNodes, {
        separationStrength: 0.5,  // Increased from default 0.3
        minDistance: 60           // Increased from default 50
      }));
      
      // Continue simulation for internal optimization
      simulation.alpha(0.18).restart();  // Increased from 0.15 for stronger refinement
      await runUntilConverged(simulation, 225, 0.0005);  // Increased from 200 for better convergence
      if (thisGeneration !== renderGeneration) return; // Stale render cancelled
    } else {
      // Single component: use original positioning
      const componentCenter = (MARGIN.top + INNER_HEIGHT) / 2;
      
      // Find hub IP for single component using the already computed componentHubIps
      const hubIp = componentHubIps.get(0) || null;
      if (hubIp) {
        console.log(`Single component hub IP: ${hubIp} (degree: ${ipDegree.get(hubIp) || 0})`);
      }
      
      // Sort nodes deterministically by degree (descending), then by IP string
      const sortedNodes = [...simNodes].sort((a, b) => {
        const degreeA = ipDegree.get(a.id) || 0;
        const degreeB = ipDegree.get(b.id) || 0;
        if (degreeB !== degreeA) return degreeB - degreeA; // Higher degree first
        return a.id.localeCompare(b.id); // Then by IP string for consistency
      });
      
      // Initialize positions deterministically: distribute evenly with hub at center
      sortedNodes.forEach((n, idx) => {
        n.x = centerX;
        if (sortedNodes.length === 1) {
          n.y = componentCenter;
        } else {
          // Distribute nodes evenly around center, with hub (first) at center
          const spread = Math.min(INNER_HEIGHT * 0.3, 50);
          const step = spread / (sortedNodes.length - 1);
          const offset = (idx - (sortedNodes.length - 1) / 2) * step;
          n.y = componentCenter + offset;
        }
        n.vx = 0;
        n.vy = 0;
      });
      
      // Add hub centering force for single component
      if (hubIp) {
        const singleComponentCenters = new Map([[0, componentCenter]]);
        const singleHubIps = new Map([[0, hubIp]]);
        simulation.force('hubCentering', createHubCenteringForce(singleHubIps, singleComponentCenters, simNodes, { hubStrength: 1.0 }));
      }

      // Add mutual hub attraction for single component
      const singleIpToComponent = new Map();
      simNodes.forEach(n => singleIpToComponent.set(n.id, 0));
      const singleHubAttraction = createMutualHubAttractionForce(
        singleIpToComponent,
        connectionStrength,
        simNodes,
        {
          attractionStrength: 0.6,  // Slightly weaker for single component
          hubThreshold: 0.3
        }
      );
      simulation.force('hubAttraction', singleHubAttraction);
      
      // Run simulation for single component
      simulation.alpha(0.15).restart();
      await runUntilConverged(simulation, 200, 0.001);
      if (thisGeneration !== renderGeneration) return; // Stale render cancelled

      // Remove hub centering force
      if (hubIp) {
        simulation.force('hubCentering', null);
      }
    }
    
    simulation.stop();
    
    // Remove the temporary forces after simulation
    simulation.force('y', null);
    simulation.force('componentSeparation', null);
    simulation.force('componentCohesion', null);
    simulation.force('hubCentering', null);
    
    // Store final positions in yMap, ensuring all are valid
    simNodes.forEach(n => {
      if (n.y !== undefined && isFinite(n.y)) {
        yMap.set(n.id, n.y);
      } else {
        console.warn('Invalid Y position for node:', n.id, n.y);
        yMap.set(n.id, (MARGIN.top + INNER_HEIGHT) / 2);
      }
    });

    // Calculate earliest timestamp for each IP (for chronological ordering)
    const earliestTime = new Map();
    linksWithNodes.forEach(link => {
      const srcIp = link.sourceNode.name;
      const tgtIp = link.targetNode.name;
      const time = link.minute;

      if (!earliestTime.has(srcIp) || time < earliestTime.get(srcIp)) {
        earliestTime.set(srcIp, time);
      }
      if (!earliestTime.has(tgtIp) || time < earliestTime.get(tgtIp)) {
        earliestTime.set(tgtIp, time);
      }
    });

    // Compact IP positions to eliminate gaps (inspired by detactTimeSeries in main.js)
    // This redistributes IPs evenly across the vertical space while:
    //  - preserving connected-component separation when multiple components exist
    //  - maintaining chronological ordering (earliest attacks at the top)
    compactIPPositions(simNodes, yMap, MARGIN.top, INNER_HEIGHT, components, ipToComponent, earliestTime);

    // Ensure all IPs in allIps have positions in yMap (safety check for any edge cases)
    // This handles any IPs that might not be in simNodes
    let maxY = MARGIN.top + 12;
    simNodes.forEach(n => {
      const y = yMap.get(n.id);
      if (y > maxY) maxY = y;
    });
    allIps.forEach(ip => {
      if (!yMap.has(ip)) {
        maxY += 15; // Add with same spacing as compaction
        yMap.set(ip, maxY);
        console.warn(`IP ${ip} not in simNodes, assigned fallback position ${maxY}`);
      }
    });

    // --- END: Full simulation ---
    // Cache the sorted IP ordering for filtered re-renders
    const sortedIpsFull = [...allIps];
    sortedIpsFull.sort((a, b) => (yMap.get(a) || 0) - (yMap.get(b) || 0));
    cachedLayoutResult = { sortedIps: sortedIpsFull };
    console.log('Cached layout result:', sortedIpsFull.length, 'IPs');
    } // end if (!canReuseCachedLayout)

    // Phase 2: Animate from current positions to sorted timeline positions
    // This follows main.js detactTimeSeries() approach - sort by Y position
    setStatus(statusEl,'Animating to timeline...');

    // Use cached ordering, filtered to IPs present in current data
    const currentIpSet = new Set(allIps);
    const sortedIps = cachedLayoutResult.sortedIps.filter(ip => currentIpSet.has(ip));

    // Update module-level sorted IPs for use by export functions
    currentSortedIps = sortedIps.slice();

    // Distribute across available height with component-aware spacing
    // For multi-component layouts: tighter spacing within components, larger gaps between
    const finalYMap = new Map();
    let dynamicInnerHeight;

    if (components && components.length > 1) {
      // Multi-component: group by component and use tighter internal spacing
      const componentGroups = [];
      sortedIps.forEach(ip => {
        const compIdx = ipToComponent.get(ip);
        if (compIdx !== undefined) {
          if (!componentGroups[compIdx]) componentGroups[compIdx] = [];
          componentGroups[compIdx].push(ip);
        }
      });

      // Remove empty slots
      const nonEmptyGroups = componentGroups.filter(g => g && g.length > 0);

      const interComponentGap = INTER_COMPONENT_GAP; // Gap between components

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
    } else {
      // Single component: uniform spacing
      const step = Math.max(MIN_IP_SPACING, Math.min((INNER_HEIGHT - 25) / (sortedIps.length + 1), 15));
      dynamicInnerHeight = Math.max(INNER_HEIGHT, 12 + sortedIps.length * step + 25);
      for (let i = 0; i < sortedIps.length; i++) {
        finalYMap.set(sortedIps[i], MARGIN.top + 12 + i * step);
      }
    }

    // Update SVG height to accommodate all IPs with minimum spacing
    const dynamicHeight = MARGIN.top + dynamicInnerHeight + MARGIN.bottom;
    // Only change SVG height if force layout isn't already rendering
    // (force_network.render sets its own viewport-based height)
    if (!forceLayout) {
      svg.attr('height', dynamicHeight);
    }
    cachedDynamicHeight = dynamicHeight;

    // Create finalY function that returns the computed positions
    const finalY = (ip) => finalYMap.get(ip);

    // Recalculate max arc radius based on actual final Y positions
    let actualMaxArcRadius = 0;
    linksWithNodes.forEach(l => {
      const y1 = finalY(l.sourceNode.name);
      const y2 = finalY(l.targetNode.name);
      if (y1 !== undefined && y2 !== undefined) {
        const arcRadius = Math.abs(y2 - y1) / 2;
        if (arcRadius > actualMaxArcRadius) actualMaxArcRadius = arcRadius;
      }
    });

    // Update x-scale range to fit arcs within viewport
    const actualXEnd = svgWidth - MARGIN.right - actualMaxArcRadius;
    currentXEnd = actualXEnd; // Update the dynamic xEnd for xScaleLens
    x.range([xStart, actualXEnd]);

    // Update axis to match new x-scale
    const actualAxisScale = d3.scaleTime()
      .domain([xMinDate, xMaxDate])
      .range([0, actualXEnd - xStart]);

    const axisSvgUpdate = d3.select('#axis-top');
    axisSvgUpdate.selectAll('*').remove();
    axisSvgUpdate.append('g')
      .attr('transform', `translate(${xStart}, 28)`)
      .call(d3.axisTop(actualAxisScale).ticks(looksAbsolute ? 7 : 7).tickFormat(d => {
        if (looksAbsolute) return utcTick(d);
        const relUnits = Math.round((d.getTime()) / unitMs);
        return `t=${relUnits}${unitSuffix}`;
      }));

    const finalSpanData = createSpanData(sortedIps, ipSpans);

    if (layoutMode === 'force_layout') {
      // === DIRECT FORCE LAYOUT: Skip timearcs animation, set final positions immediately ===

      // Set arc paths to final positions but hidden
      arcPaths.attr('d', d => {
        const xp = xScaleLens(d.minute);
        const a = finalY(d.sourceNode.name);
        const b = finalY(d.targetNode.name);
        if (!isFinite(xp) || !isFinite(a) || !isFinite(b)) return 'M0,0 L0,0';
        d.source.x = xp; d.source.y = a;
        d.target.x = xp; d.target.y = b;
        return linkArc(d);
      }).style('display', 'none');

      // Set row lines to final positions but hidden
      rows.selectAll('line')
        .data(finalSpanData, d => d.ip)
        .attr('x1', d => d.span ? xScaleLens(d.span.min) : MARGIN.left)
        .attr('x2', d => d.span ? xScaleLens(d.span.max) : MARGIN.left)
        .attr('y1', d => finalY(d.ip))
        .attr('y2', d => finalY(d.ip))
        .style('opacity', 0)
        .style('pointer-events', 'none');

      // Set labels to final positions but hidden
      rows.selectAll('text')
        .data(sortedIps, d => d)
        .attr('y', d => finalY(d))
        .attr('x', d => {
          const node = ipToNode.get(d);
          return node && node.xConnected !== undefined ? node.xConnected : MARGIN.left;
        })
        .style('opacity', 0)
        .style('pointer-events', 'none');

      // Hide component toggles
      if (componentToggles && !componentToggles.empty()) {
        componentToggles.style('opacity', 0).style('pointer-events', 'none');
      }

      // Update gradients to final positions
      linksWithNodes.forEach(d => {
        svg.select(`#${gradIdForLink(d)}`)
          .attr('y1', finalY(d.sourceNode.name))
          .attr('y2', finalY(d.targetNode.name));
      });

      // Store evenly distributed positions for yScaleLens
      evenlyDistributedYPositions = new Map();
      sortedIps.forEach(ip => {
        evenlyDistributedYPositions.set(ip, finalY(ip));
      });

      // Update node positions
      updateNodePositions();

      // Update brush extent
      if (brushGroup && brush) {
        brush.extent([[MARGIN.left, MARGIN.top], [width + MARGIN.left, dynamicHeight]]);
        brushGroup.call(brush);
      }

      // Generate IP communications list
      generateIPCommunicationsList(data, linksWithNodes, colorForAttack);

    } else {
    // === TIMEARCS MODE: Animate everything to timeline ===
    // Update lines - rebind to sorted data
    rows.selectAll('line')
      .data(finalSpanData, d => d.ip)
      .transition().duration(1200)
      .attr('x1', d => d.span ? xScaleLens(d.span.min) : MARGIN.left)
      .attr('x2', d => d.span ? xScaleLens(d.span.max) : MARGIN.left)
      .tween('y-line', function(d) {
        const yStart = y(d.ip);
        const yEnd = finalY(d.ip);
        const interp = d3.interpolateNumber(yStart, yEnd);
        const self = d3.select(this);
        return function(t) {
          const yy = interp(t);
          self.attr('y1', yy).attr('y2', yy);
        };
      })
      .style('opacity', 1);

    // Update labels - rebind to sorted order to ensure alignment
    const finalIpLabelsSelection = rows.selectAll('text')
      .data(sortedIps, d => d); // Use key function to match by IP string

    // Add hover handlers to the selection (they persist through transition)
    finalIpLabelsSelection
      .on('mouseover', function (event, hoveredIp) {
        // Find all arcs connected to this IP (as source or target)
        const connectedArcs = linksWithNodes.filter(l => l.sourceNode.name === hoveredIp || l.targetNode.name === hoveredIp);
        const connectedIps = new Set();
        connectedArcs.forEach(l => {
          connectedIps.add(l.sourceNode.name);
          connectedIps.add(l.targetNode.name);
        });

        // Highlight connected arcs: full opacity for connected, dim others
        arcPaths.style('stroke-opacity', d => {
          const isConnected = d.sourceNode.name === hoveredIp || d.targetNode.name === hoveredIp;
          return isConnected ? 1 : 0.2;
        })
        .attr('stroke-width', d => {
          const isConnected = d.sourceNode.name === hoveredIp || d.targetNode.name === hoveredIp;
          if (isConnected) {
            const baseW = widthScale(Math.max(1, d.count));
            return Math.max(3, baseW < 2 ? baseW * 2.5 : baseW * 1.3);
          }
          return widthScale(Math.max(1, d.count));
        });

        // Highlight row lines for connected IPs
        svg.selectAll('.row-line')
          .attr('stroke-opacity', s => s && s.ip && connectedIps.has(s.ip) ? 0.8 : 0.1)
          .attr('stroke-width', s => s && s.ip && connectedIps.has(s.ip) ? 1 : 0.4);

        // Highlight IP labels for connected IPs
        const hoveredLabel = d3.select(this);
        const hoveredColor = hoveredLabel.style('fill') || '#343a40';
        svg.selectAll('.ip-label')
          .attr('font-weight', s => connectedIps.has(s) ? 'bold' : null)
          .style('font-size', s => connectedIps.has(s) ? '14px' : null)
          .style('fill', s => {
            if (s === hoveredIp) return hoveredColor;
            return connectedIps.has(s) ? '#007bff' : '#343a40';
          });

        // Show tooltip with IP information
        const arcCount = connectedArcs.length;
        const uniqueConnections = new Set();
        connectedArcs.forEach(l => {
          if (l.sourceNode.name === hoveredIp) uniqueConnections.add(l.targetNode.name);
          if (l.targetNode.name === hoveredIp) uniqueConnections.add(l.sourceNode.name);
        });
        const content = `IP: ${hoveredIp}<br>` +
          `Connected arcs: ${arcCount}<br>` +
          `Unique connections: ${uniqueConnections.size}`;
        showTooltip(tooltip, event, content);
      })
      .on('mousemove', function (event) {
        // Keep tooltip following cursor
        if (tooltip && tooltip.style.display !== 'none') {
          const pad = 10;
          tooltip.style.left = (event.clientX + pad) + 'px';
          tooltip.style.top = (event.clientY + pad) + 'px';
        }
      })
      .on('mouseout', function () {
        hideTooltip(tooltip);
        // Restore default state
        arcPaths.style('stroke-opacity', 0.6)
                .attr('stroke-width', d => widthScale(Math.max(1, d.count)));
        svg.selectAll('.row-line').attr('stroke-opacity', 1).attr('stroke-width', 0.4);
        svg.selectAll('.ip-label')
          .attr('font-weight', null)
          .style('font-size', null)
          .style('fill', '#343a40')
          .style('opacity', d => {
            // Restore opacity based on component expansion state
            const compIdx = ipToComponent.get(d);
            if (compIdx === undefined) return 1;
            return componentExpansionState.get(compIdx) === true ? 1 : 0;
          });
      });

    // Animate labels to final positions (matching main.js updateTransition)
    // Update node positions first, then animate labels to xConnected positions
    updateNodePositions();
    finalIpLabelsSelection
      .transition().duration(1200)
      .tween('y-text', function(d) {
        const yStart = y(d);
        const yEnd = finalY(d);
        const interp = d3.interpolateNumber(yStart, yEnd);
        const self = d3.select(this);
        return function(t) { self.attr('y', interp(t)); };
      })
      .attr('x', d => {
        // Match main.js: position at xConnected (strongest connection time)
        const node = ipToNode.get(d);
        return node && node.xConnected !== undefined ? node.xConnected : MARGIN.left;
      })
      .style('opacity', d => {
        const compIdx = ipToComponent.get(d);
        if (compIdx === undefined) return 1;
        return componentExpansionState.get(compIdx) === true ? 1 : 0;
      })
      .text(d => d); // Re-apply text in case order changed

    // Animate arcs with proper interpolation to final positions (matching main.js pattern)
    arcPaths.transition().duration(1200)
      .attrTween('d', function(d) {
        const xp = xScaleLens(d.minute);
        // Start at current scale positions; end at finalY
        const y1Start = y(d.sourceNode.name);
        const y2Start = y(d.targetNode.name);
        const y1End = finalY(d.sourceNode.name) ?? y1Start;
        const y2End = finalY(d.targetNode.name) ?? y2Start;
        if (!isFinite(xp) || !isFinite(y1End) || !isFinite(y2End)) {
          return function() { return 'M0,0 L0,0'; };
        }
        return function(t) {
          const y1t = y1Start + (y1End - y1Start) * t;
          const y2t = y2Start + (y2End - y2Start) * t;
          // Update node positions for linkArc (matching main.js)
          d.source.x = xp;
          d.source.y = y1t;
          d.target.x = xp;
          d.target.y = y2t;
          return linkArc(d);
        };
      })
      .on('end', (d, i) => {
        // Update gradient to final positions so grey->attack aligns with endpoints
        const xp = xScaleLens(d.minute);
        const y1f = finalY(d.sourceNode.name);
        const y2f = finalY(d.targetNode.name);
        svg.select(`#${gradIdForLink(d)}`)
          .attr('x1', xp)
          .attr('x2', xp)
          .attr('y1', y1f)
          .attr('y2', y2f);
        if (i === 0) {
          // Recompute arc paths using finalY positions to lock alignment (matching main.js)
          arcPaths.attr('d', dd => {
            const xp2 = xScaleLens(dd.minute);
            const a = finalY(dd.sourceNode.name);
            const b = finalY(dd.targetNode.name);
            if (!isFinite(xp2) || !isFinite(a) || !isFinite(b)) return 'M0,0 L0,0';
            // Update node positions for linkArc
            dd.source.x = xp2;
            dd.source.y = a;
            dd.target.x = xp2;
            dd.target.y = b;
            return linkArc(dd);
          });

          // Store evenly distributed positions for yScaleLens to use
          evenlyDistributedYPositions = new Map();
          sortedIps.forEach(ip => {
            evenlyDistributedYPositions.set(ip, finalY(ip));
          });

          // Update node positions to reflect the new evenly distributed y positions
          updateNodePositions();

          // Update component toggle positions to match final layout
          if (componentToggles && !componentToggles.empty()) {
            componentToggles.attr('transform', d => `translate(8, ${finalY(d.ip)})`);

            // Show toggles now that visualization is stable
            showComponentToggles(componentToggles, 400);
          }

          // Update brush extent to match dynamic height
          if (brushGroup && brush) {
            brush.extent([[MARGIN.left, MARGIN.top], [width + MARGIN.left, dynamicHeight]]);
            brushGroup.call(brush);
          }

          setStatus(statusEl,`${data.length} records • ${sortedIps.length} IPs • ${attacks.length} ${labelMode==='force_layout' ? 'attack groups' : 'attack types'}`);

          // Generate IP communications list after data is fully loaded
          generateIPCommunicationsList(data, linksWithNodes, colorForAttack);

          // Auto-fit disabled to match main.js detactTimeSeries() behavior
          // setTimeout(() => autoFitArcs(), 100);
        }
      });
    } // end timearcs animation

    // Auto-fit arcs function: adaptively space IPs to fit in viewport
    function autoFitArcs() {
      console.log('Auto-fit called, IPs:', sortedIps.length);

      const hasMultipleComponents = components && components.length > 1;
      const gapTokenPrefix = '__gap__';

      function buildComponentAwareDomain() {
        if (!hasMultipleComponents) return sortedIps.slice();
        const domain = [];
        const gapSlots = 3; // virtual slots to enforce breathing room between disconnected clusters
        for (let i = 0; i < sortedIps.length; i++) {
          const ip = sortedIps[i];
          domain.push(ip);
          const nextIp = sortedIps[i + 1];
          if (!nextIp) continue;
          const currComp = ipToComponent.has(ip) ? ipToComponent.get(ip) : -1;
          const nextComp = ipToComponent.has(nextIp) ? ipToComponent.get(nextIp) : -1;
          if (currComp !== nextComp) {
            for (let slot = 0; slot < gapSlots; slot++) {
              domain.push(`${gapTokenPrefix}${currComp}_${i}_${slot}`);
            }
          }
        }
        return domain;
      }

      const autoFitDomain = buildComponentAwareDomain();
      const availableHeight = Math.max(60, height - MARGIN.top - MARGIN.bottom - 25);
      const maxStep = 12; // tighter maximum spacing between rows
      const padding = 0.3;
      const domainSpan = Math.max(1, autoFitDomain.length - 1);
      const desiredSpan = Math.min(availableHeight, domainSpan * maxStep);
      const rangeStart = MARGIN.top + 12;
      const rangeEnd = rangeStart + desiredSpan;

      // Snapshot current scale so we can tween from existing positions
      const startYScale = finalY.copy();

      const autoFitY = d3.scalePoint()
        .domain(autoFitDomain)
        .range([rangeStart, rangeEnd])
        .padding(padding);

      const targetPositions = new Map();
      autoFitDomain.forEach(token => {
        if (!token.startsWith(gapTokenPrefix)) {
          targetPositions.set(token, autoFitY(token));
        }
      });

      // Animate to new positions while preserving component separation
      rows.selectAll('line')
        .transition().duration(800)
        .tween('y-line', function(d) {
          const yStart = startYScale(d.ip);
          const yEnd = targetPositions.get(d.ip) ?? yStart;
          const interp = d3.interpolateNumber(yStart, yEnd);
          const self = d3.select(this);
          return function(t) {
            const yy = interp(t);
            self.attr('y1', yy).attr('y2', yy);
          };
        });

      rows.selectAll('text')
        .transition().duration(800)
        .tween('y-text', function(d) {
          const yStart = startYScale(d);
          const yEnd = targetPositions.get(d) ?? yStart;
          const interp = d3.interpolateNumber(yStart, yEnd);
          const self = d3.select(this);
          return function(t) { self.attr('y', interp(t)); };
        })
        .attr('x', d => {
          // Maintain xConnected position (strongest connection time) during auto-fit
          const node = ipToNode.get(d);
          return node && node.xConnected !== undefined ? node.xConnected : MARGIN.left;
        });

      // Animate component toggles to new positions
      if (componentToggles && !componentToggles.empty()) {
        componentToggles
          .transition().duration(800)
          .attr('transform', d => {
            const yEnd = targetPositions.get(d.ip) ?? startYScale(d.ip);
            return `translate(8, ${yEnd})`;
          });
      }

      arcPaths.transition().duration(800)
        .attrTween('d', function(d) {
          const xp = xScaleLens(d.minute);
          const y1Start = startYScale(d.sourceNode.name);
          const y2Start = startYScale(d.targetNode.name);
          const y1End = targetPositions.get(d.sourceNode.name) ?? y1Start;
          const y2End = targetPositions.get(d.targetNode.name) ?? y2Start;
          return function(t) {
            const y1t = y1Start + (y1End - y1Start) * t;
            const y2t = y2Start + (y2End - y2Start) * t;
            // Update node positions for linkArc (matching main.js)
            d.source.x = xp;
            d.source.y = y1t;
            d.target.x = xp;
            d.target.y = y2t;
            return linkArc(d);
          };
        })
        .on('end', () => {
          const newRange = autoFitY.range();
          y.domain(autoFitDomain).range(newRange);
          finalY.domain(autoFitDomain).range(newRange);
          const spacingSample = sortedIps.length > 1
            ? Math.abs((targetPositions.get(sortedIps[1]) ?? 0) - (targetPositions.get(sortedIps[0]) ?? 0))
            : 0;
          const compMsg = hasMultipleComponents ? ' (component gaps preserved)' : '';
          setStatus(statusEl,`Auto-fit: ${sortedIps.length} IPs${compMsg} with ${(spacingSample || maxStep).toFixed(1)}px spacing`);

          // Determine whether baseline labels have enough vertical space.
          let minSpacing = Infinity;
          if (sortedIps.length > 1) {
            for (let i = 1; i < sortedIps.length; i++) {
              const prev = sortedIps[i - 1];
              const curr = sortedIps[i];
              const yPrev = y(prev);
              const yCurr = y(curr);
              if (isFinite(yPrev) && isFinite(yCurr)) {
                const dy = Math.abs(yCurr - yPrev);
                if (dy < minSpacing) minSpacing = dy;
              }
            }
          }
          const labelSpacingThreshold = 10; // px
          labelsCompressedMode = minSpacing < labelSpacingThreshold;
          const baseLabelSel = rows.selectAll('text');
          if (labelsCompressedMode) {
            // Hide baseline labels when there is not enough space (matching main.js: no vertical lensing)
            baseLabelSel.style('opacity', 0);
          } else {
            baseLabelSel.style('opacity', 1);
          }

        });

      linksWithNodes.forEach(d => {
        const xp = xScaleLens(d.minute);
        svg.select(`#${gradIdForLink(d)}`)
          .transition().duration(800)
          .attr('y1', targetPositions.get(d.sourceNode.name) ?? startYScale(d.sourceNode.name))
          .attr('y2', targetPositions.get(d.targetNode.name) ?? startYScale(d.targetNode.name));
      });
    }

    // Apply component layout with current expansion state
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

      // Update component toggles
      if (componentToggles && !componentToggles.empty()) {
        componentToggles
          .transition().duration(duration)
          .attr('transform', d => `translate(8, ${newFinalYMap.get(d.ip)})`);

        // Update toggle state (visual only - colors and icons)
        updateComponentToggles(componentToggles, componentExpansionState);
      }

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

    // Update visualization with current bifocal state
    function updateBifocalVisualization() {
      // In force layout mode, use the focus region as a time-range filter
      if (layoutMode === 'force_layout' && forceLayout) {
        const fs = bifocalState.focusStart;
        const fe = bifocalState.focusEnd;
        // Full range → show everything
        if (fs <= 0.01 && fe >= 0.99) {
          forceLayout.updateTimeFilter(null);
        } else {
          const min = _renderTsMin + fs * (_renderTsMax - _renderTsMin);
          const max = _renderTsMin + fe * (_renderTsMax - _renderTsMin);
          forceLayout.updateTimeFilter({ min, max });
        }
        updateBifocalRegionText();
        if (bifocalHandles) bifocalHandles.updateHandlePositions();
        return;
      }

      // During drag: immediate updates (no transitions) for responsiveness
      const dragging = bifocalHandles && bifocalHandles.isDragging;
      const dur = dragging ? 0 : 250;

      // Animate arcs to new positions
      const arcSel = dur > 0 ? arcPaths.transition().duration(dur) : arcPaths;
      arcSel.attr('d', d => {
          const xp = xScaleLens(d.minute);
          const y1 = yScaleLens(d.sourceNode.name);
          const y2 = yScaleLens(d.targetNode.name);
          d.source.x = xp;
          d.source.y = y1;
          d.target.x = xp;
          d.target.y = y2;
          return linkArc(d);
        });

      // Update gradients (batch selection instead of per-link svg.select)
      const gradSel = dur > 0
        ? gradients.transition().duration(dur)
        : gradients;
      gradSel
        .attr('x1', d => xScaleLens(d.minute))
        .attr('x2', d => xScaleLens(d.minute))
        .attr('y1', d => yScaleLens(d.sourceNode.name))
        .attr('y2', d => yScaleLens(d.targetNode.name));

      // Update row lines
      const lineSel = dur > 0
        ? rows.selectAll('line').transition().duration(dur)
        : rows.selectAll('line');
      lineSel
        .attr('x1', d => d.span ? xScaleLens(d.span.min) : MARGIN.left)
        .attr('x2', d => d.span ? xScaleLens(d.span.max) : MARGIN.left)
        .attr('y1', d => yScaleLens(d.ip))
        .attr('y2', d => yScaleLens(d.ip));

      // Update node positions
      updateNodePositions();

      // Update IP label positions
      const textSel = dur > 0
        ? rows.selectAll('text').transition().duration(dur)
        : rows.selectAll('text');
      textSel
        .attr('y', d => yScaleLens(d))
        .attr('x', d => {
          const node = ipToNode.get(d);
          return node && node.xConnected !== undefined ? node.xConnected : MARGIN.left;
        })
        .style('opacity', d => {
          const compIdx = ipToComponent.get(d);
          if (compIdx === undefined) return 1;
          return componentExpansionState.get(compIdx) === true ? 1 : 0;
        });

      // Update component toggle positions
      if (componentToggles && !componentToggles.empty()) {
        const toggleSel = dur > 0
          ? componentToggles.transition().duration(dur)
          : componentToggles;
        toggleSel.attr('transform', d => `translate(8, ${yScaleLens(d.ip)})`);
      }

      // Update axis ticks
      const axisSvg = d3.select('#axis-top');
      const axisGroup = axisSvg.select('g');

      const tempScale = d3.scaleTime()
        .domain([xMinDate, xMaxDate])
        .range([0, timelineWidth]);

      const tickValues = tempScale.ticks(7);

      const tickSel = dur > 0
        ? axisGroup.selectAll('.tick').data(tickValues).transition().duration(dur)
        : axisGroup.selectAll('.tick').data(tickValues);
      tickSel.attr('transform', function(d) {
          let timestamp;
          if (looksAbsolute) {
            if (unit === 'microseconds') timestamp = d.getTime() * 1000;
            else if (unit === 'milliseconds') timestamp = d.getTime();
            else if (unit === 'seconds') timestamp = d.getTime() / 1000;
            else if (unit === 'minutes') timestamp = d.getTime() / 60000;
            else timestamp = d.getTime() / 3600000;
          } else {
            timestamp = (d.getTime() / unitMs) + base;
          }

          const newX = xScaleLens(timestamp) - xStart;
          return `translate(${newX},0)`;
        });

      // Update bifocal handles
      if (bifocalHandles) {
        bifocalHandles.updateHandlePositions();
      }

      // Update region indicator
      updateBifocalRegionText();

      // Update persistent brush selections
      if (updatePersistentSelectionVisuals) {
        updatePersistentSelectionVisuals();
      }
    }

    // Store reference to updateBifocalVisualization
    updateBifocalVisualizationFn = updateBifocalVisualization;

    // Store module-level references for force layout transitions
    _renderLinksWithNodes = linksWithNodes;
    _renderAllIps = allIps;
    _renderIpToComponent = ipToComponent;
    _renderComponents = components;
    _renderYScaleLens = yScaleLens;
    _renderXScaleLens = xScaleLens;
    _renderXStart = xStart;
    _renderColorForAttack = colorForAttack;
    _renderTsMin = tsMin;
    _renderTsMax = tsMax;

    // Create bifocal drag handles in the sticky bifocal-bar SVG (not the scrollable chart SVG)
    const bifocalBarSvg = d3.select('#bifocal-bar');
    bifocalBarSvg
      .attr('width', width + MARGIN.left + MARGIN.right)
      .attr('height', 28);
    bifocalBarSvg.selectAll('*').remove();
    bifocalHandles = createBifocalHandles(bifocalBarSvg, {
      xStart,
      xEnd: currentXEnd,
      axisY: 14,
      chartHeight: 28,
      getBifocalState: () => bifocalState,
      onFocusChange: (newStart, newEnd) => {
        const newState = updateFocusRegion(bifocalState, newStart, newEnd);
        bifocalState = newState;
        updateBifocalVisualization();
      },
      d3
    });
    bifocalHandles.show();

    // Show and update region indicator
    if (bifocalRegionIndicator) {
      bifocalRegionIndicator.style.display = 'block';
      updateBifocalRegionText();
    }

    // Re-initialize resize handler after render completes
    resizeCleanup = setupWindowResizeHandler();

    // Fallback: if force layout is default but wasn't shown earlier (shouldn't happen)
    if (layoutMode === 'force_layout' && !forceLayout) {
      showForceLayoutDirectly();
    }
  }

  // Compute nodes array with connectivity metric akin to legacy computeNodes
  function computeNodes(data) {
    const relationships = buildRelationships(data);
    const totals = new Map(); // ip -> total count across records
    const ipMinuteCounts = new Map(); // ip -> Map(minute -> sum)
    const ipSet = new Set();
    for (const row of data) {
      ipSet.add(row.src_ip); ipSet.add(row.dst_ip);
      totals.set(row.src_ip, (totals.get(row.src_ip) || 0) + (row.count || 1));
      totals.set(row.dst_ip, (totals.get(row.dst_ip) || 0) + (row.count || 1));
      if (!ipMinuteCounts.has(row.src_ip)) ipMinuteCounts.set(row.src_ip, new Map());
      if (!ipMinuteCounts.has(row.dst_ip)) ipMinuteCounts.set(row.dst_ip, new Map());
      const m = row.timestamp, c = (row.count || 1);
      ipMinuteCounts.get(row.src_ip).set(m, (ipMinuteCounts.get(row.src_ip).get(m) || 0) + c);
      ipMinuteCounts.get(row.dst_ip).set(m, (ipMinuteCounts.get(row.dst_ip).get(m) || 0) + c);
    }

    // Connectivity per IP using legacy-style rule: take the max pair frequency over time,
    // filtered by a threshold (valueSlider-equivalent). Lower time wins on ties.
    const connectivityThreshold = 1;
    const isConnected = computeConnectivityFromRelationships(relationships, connectivityThreshold, ipSet);

    // Build nodes list
    let id = 0;
    const nodes = Array.from(ipSet).map(ip => {
      const series = ipMinuteCounts.get(ip) || new Map();
      let maxMinuteVal = 0; let maxMinute = null;
      for (const [m, v] of series.entries()) { if (v > maxMinuteVal) { maxMinuteVal = v; maxMinute = m; } }
      const conn = isConnected.get(ip) || { max: 0, time: null };
      return {
        id: id++,
        name: ip,
        total: totals.get(ip) || 0,
        maxMinuteVal,
        maxMinute,
        isConnected: conn.max,
        isConnectedMaxTime: conn.time,
      };
    });

    // Sort: connectivity desc, then total desc, then name asc
    nodes.sort((a, b) => {
      if (b.isConnected !== a.isConnected) return b.isConnected - a.isConnected;
      if (b.total !== a.total) return b.total - a.total;
      return a.name.localeCompare(b.name, 'en');
    });

    return { nodes, relationships };
  }

  // Compact IP positions to eliminate vertical gaps and minimize arc crossing.
  // When information about connected components is available, we keep each
  // disconnected component in its own contiguous vertical block so that
  // isolated clusters of IPs/links do not get interleaved visually.
  // IPs are ordered chronologically (earliest attacks at the top).
  function compactIPPositions(simNodes, yMap, topMargin, INNER_HEIGHT, components, ipToComponent, earliestTime, connectionStrength) {
    const numIPs = simNodes.length;
    if (numIPs === 0) return;

    // Handle single component case with chronological ordering
    if (components.length <= 1) {
      const ipArray = [];
      simNodes.forEach(n => {
        const time = earliestTime.get(n.id) || Infinity;
        ipArray.push({ ip: n.id, time: time });
      });

      // Sort by earliest time (ascending - earliest first = top)
      ipArray.sort((a, b) => a.time - b.time);

      const step = Math.max(MIN_IP_SPACING, Math.min((INNER_HEIGHT - 25) / (ipArray.length + 1), 15));
      ipArray.forEach((item, i) => {
        const newY = topMargin + 12 + i * step;
        yMap.set(item.ip, newY);
      });

      console.log(`Compacted ${ipArray.length} IPs chronologically with ${step.toFixed(2)}px spacing`);
      return;
    }

    // Multi-component: preserve separation by grouping IPs by component

    // Step 1: Group IPs by component and sort within each component by earliest time
    const componentIpGroups = components.map((comp, idx) => {
      const ipsInComponent = [];
      simNodes.forEach(n => {
        if (ipToComponent.get(n.id) === idx) {
          const time = earliestTime.get(n.id) || Infinity;
          ipsInComponent.push({ ip: n.id, time: time });
        }
      });
      // Sort within component by chronological order (earliest first = top)
      ipsInComponent.sort((a, b) => a.time - b.time);

      // Calculate component's earliest time (minimum of all IPs in component)
      // Use efficient iteration to avoid stack overflow with large components
      let componentEarliestTime = Infinity;
      if (ipsInComponent.length > 0) {
        for (let i = 0; i < ipsInComponent.length; i++) {
          const time = ipsInComponent[i].time;
          if (isFinite(time) && time < componentEarliestTime) {
            componentEarliestTime = time;
          }
        }
      }

      return {
        ips: ipsInComponent,
        earliestTime: componentEarliestTime,
        componentIndex: idx
      };
    });

    // Sort components by earliest time (earliest component at top)
    componentIpGroups.sort((a, b) => a.earliestTime - b.earliestTime);

    // Step 2: Calculate space allocation
    const minIPSpacing = 15;
    const interComponentGap = INTER_COMPONENT_GAP; // Explicit gap between components

    const numGaps = components.length - 1;
    const spaceForGaps = numGaps * interComponentGap;
    const spaceForIPs = INNER_HEIGHT - 25 - spaceForGaps;

    // Calculate IP spacing (may be less than minIPSpacing if crowded)
    // Use tighter spacing within components to make each component visually distinct
    const ipStep = Math.max(
      Math.min(spaceForIPs / (numIPs + 1), minIPSpacing),
      MIN_IP_SPACING_WITHIN_COMPONENT // Tighter spacing within same component
    );

    // Step 3: Position IPs component-by-component (in chronological order)
    let currentY = topMargin + 12;

    componentIpGroups.forEach((compGroup, idx) => {
      compGroup.ips.forEach((item, i) => {
        yMap.set(item.ip, currentY);
        currentY += ipStep;
      });

      // Add inter-component gap (except after last component)
      if (idx < componentIpGroups.length - 1) {
        currentY += interComponentGap;
      }
    });

    console.log(`Compacted ${numIPs} IPs across ${components.length} components chronologically (${ipStep.toFixed(2)}px spacing, ${interComponentGap}px gaps)`);
  }

  // Order nodes like the TSX component:
  // 1) Build force-simulated y for natural local ordering
  // 2) Determine each IP's primary (most frequent) non-normal attack type
  // 3) Order attack groups by earliest time they appear
  // 4) Within each group, order by simulated y; then assign evenly spaced positions later via scale
  function computeNodesByAttackGrouping(links) {
    const ipSet = new Set();
    for (const l of links) { ipSet.add(l.source); ipSet.add(l.target); }

    // Build pair weights ignoring minute to feed simulation, and track
    // whether each pair ever participates in a non-'normal' attack. We
    // will use only those non-normal edges for component detection so
    // that benign/background traffic does not glue unrelated attack
    // clusters into a single component.
    const pairKey = (a,b)=> a<b?`${a}__${b}`:`${b}__${a}`;
    const pairWeights = new Map();
    const pairHasNonNormalAttack = new Map(); // key -> boolean
    for (const l of links) {
      const k = pairKey(l.source,l.target);
      pairWeights.set(k,(pairWeights.get(k)||0)+ (l.count||1));
      if (l.attack && l.attack !== 'normal') {
        pairHasNonNormalAttack.set(k, true);
      }
    }

    const simNodes = Array.from(ipSet).map(id=>({id}));
    const simLinks = [];
    const componentLinks = [];
    for (const [k,w] of pairWeights.entries()) {
      const [a,b] = k.split('__');
      const link = {source:a,target:b,value:w};
      simLinks.push(link);
      if (pairHasNonNormalAttack.get(k)) {
        componentLinks.push({ source: a, target: b });
      }
    }

    // Detect connected components for better separation. Prefer to use
    // only edges that have at least one non-'normal' attack so that
    // purely-normal background traffic does not connect unrelated
    // attack clusters. If everything is 'normal', fall back to using
    // the full link set.
    const topologicalComponents = findConnectedComponents(
      simNodes,
      componentLinks.length > 0 ? componentLinks : simLinks
    );

    // Debug: log topological component information
    if (topologicalComponents.length > 1) {
      console.log(`Detected ${topologicalComponents.length} topological components:`,
        topologicalComponents.map((comp, idx) => `Component ${idx}: ${comp.length} nodes`).join(', '));
    }

    // Determine primary attack type for each IP first (needed for component merging)
    const ipAttackCounts = new Map(); // ip -> Map(attack->count)
    for (const l of links) {
      if (l.attack && l.attack !== 'normal'){
        for (const ip of [l.source,l.target]){
          if (!ipAttackCounts.has(ip)) ipAttackCounts.set(ip,new Map());
          const m = ipAttackCounts.get(ip); m.set(l.attack,(m.get(l.attack)||0)+(l.count||1));
        }
      }
    }
    const primaryAttack = new Map();
    for (const ip of ipSet){
      const m = ipAttackCounts.get(ip);
      if (!m || m.size===0) { primaryAttack.set(ip,'unknown'); continue; }
      let best='unknown',bestC=-1; for (const [att,c] of m.entries()) if (c>bestC){best=att;bestC=c;}
      primaryAttack.set(ip,best);
    }

    // Merge components by attack type: components with the same primary attack type are merged
    const componentPrimaryAttack = new Map(); // compIdx -> primary attack type
    topologicalComponents.forEach((comp, compIdx) => {
      // Find most common attack type in this component
      const attackCounts = new Map();
      comp.forEach(ip => {
        const attack = primaryAttack.get(ip) || 'unknown';
        attackCounts.set(attack, (attackCounts.get(attack) || 0) + 1);
      });
      let bestAttack = 'unknown', bestCount = -1;
      for (const [attack, count] of attackCounts.entries()) {
        if (count > bestCount) {
          bestCount = count;
          bestAttack = attack;
        }
      }
      componentPrimaryAttack.set(compIdx, bestAttack);
    });

    // Group topological components by their primary attack type
    const attackToComponents = new Map(); // attack -> [compIdx, ...]
    componentPrimaryAttack.forEach((attack, compIdx) => {
      if (!attackToComponents.has(attack)) attackToComponents.set(attack, []);
      attackToComponents.get(attack).push(compIdx);
    });

    // Create merged components: flatten components with same attack type
    const components = [];
    const oldToNewComponentIdx = new Map(); // old compIdx -> new compIdx
    attackToComponents.forEach((compIndices, attack) => {
      const newCompIdx = components.length;
      const mergedComponent = [];
      compIndices.forEach(oldCompIdx => {
        oldToNewComponentIdx.set(oldCompIdx, newCompIdx);
        mergedComponent.push(...topologicalComponents[oldCompIdx]);
      });
      components.push(mergedComponent);
    });

    // Build ipToComponent mapping with merged components
    const ipToComponent = new Map();
    components.forEach((comp, compIdx) => {
      comp.forEach(ip => ipToComponent.set(ip, compIdx));
    });

    // Debug: log merged component information
    if (components.length > 1) {
      console.log(`Merged ${topologicalComponents.length} topological components into ${components.length} attack-based components:`);
      components.forEach((comp, idx) => {
        const attack = componentPrimaryAttack.get(
          Array.from(oldToNewComponentIdx.entries()).find(([old, newIdx]) => newIdx === idx)?.[0]
        );
        console.log(`  Component ${idx} (${attack}): ${comp.length} nodes`);
      });
    }

    // Return raw data for simulation - simulation will be created in render()
    // using the imported createForceSimulation function
    
    // Initialize empty yMap - will be populated during render
    const yMap = new Map();

    // Primary attack per IP was already computed above during component merging

    // Earliest time per attack type
    const earliest = new Map();
    for (const l of links){
      if (!l.attack || l.attack==='normal') continue;
      const t = earliest.get(l.attack);
      earliest.set(l.attack, t===undefined? l.minute : Math.min(t,l.minute));
    }

    // Group IPs by attack
    const groups = new Map(); // attack -> array of ips
    for (const ip of ipSet){
      const att = primaryAttack.get(ip) || 'unknown';
      if (!groups.has(att)) groups.set(att,[]);
      groups.get(att).push(ip);
    }

    // Sort groups by earliest time, unknown last
    const groupList = Array.from(groups.keys()).sort((a,b)=>{
      if (a==='unknown' && b!=='unknown') return 1;
      if (b==='unknown' && a!=='unknown') return -1;
      const ta = earliest.get(a); const tb = earliest.get(b);
      if (ta===undefined && tb===undefined) return a.localeCompare(b);
      if (ta===undefined) return 1; if (tb===undefined) return -1; return ta - tb;
    });

    // Flatten nodes in group order; within group by simulated y
    const nodes = [];
    for (const g of groupList){
      const arr = groups.get(g) || [];
      arr.sort((a,b)=> (yMap.get(a)||0) - (yMap.get(b)||0));
      for (const ip of arr) nodes.push({ name: ip, group: g });
    }
    return { nodes, simNodes, simLinks, yMap, components, ipToComponent };
  }

  // Wrapper for decodeIp that provides global maps
  const _decodeIp = (value) => decodeIp(value, ipIdToAddr);

  // Helper: detect set number from filename (e.g., "set1_full_min.csv" -> 1)
  function detectSetNumber(filename) {
    const match = filename.match(/set(\d+)/i);
    return match ? parseInt(match[1], 10) : null;
  }

  // Helper: detect day number from filename (e.g., "day5_attacks.csv" -> 5)
  function detectDayNumber(filename) {
    const match = filename.match(/day(\d+)/i);
    return match ? parseInt(match[1], 10) : null;
  }

  // Map timearcs data filename to Python input filename
  // e.g., "set1_full_min_matched_attacks_out.csv" -> "decoded_set1_full.csv"
  // e.g., "set1_first90_minutes.csv" -> "decoded_set1_full.csv"
  function mapToDecodedFilename(timearcsFilename) {
    // Extract set number
    const setMatch = timearcsFilename.match(/set(\d+)/i);
    if (!setMatch) {
      // If no set number found, try to preserve original name with decoded prefix
      return timearcsFilename.replace(/^/, 'decoded_').replace(/_matched_attacks_out\.csv$/i, '.csv');
    }
    
    const setNum = setMatch[1];
    // Map to decoded filename format: decoded_set{N}_full.csv
    return `decoded_set${setNum}_full.csv`;
  }

  // Update dataset config based on loaded files
  function updateDatasetConfig() {
    if (loadedFileInfo.length === 0) return;
    
    // Build sets from loaded file info
    datasetConfig.sets = loadedFileInfo.map(info => ({
      fileName: info.fileName, // Original timearcs filename
      decodedFileName: info.decodedFileName, // Python input filename
      filePath: info.filePath,
      minTime: info.minTime,
      maxTime: info.maxTime,
      setNumber: info.setNumber,
      dayNumber: info.dayNumber,
      recordCount: info.recordCount
    }));
    
    datasetConfig.autoDetected = true;
    
    console.log('Dataset config updated:', datasetConfig);
  }

  // Determine which data files cover a given time range
  function getFilesForTimeRange(minTime, maxTime) {
    if (!datasetConfig.sets || datasetConfig.sets.length === 0) {
      return {
        files: [],
        suggestion: '<INPUT_CSV_FILES>',
        detected: false
      };
    }
    
    // Find all files whose time ranges overlap with [minTime, maxTime]
    const matchingFiles = datasetConfig.sets.filter(set => {
      if (set.minTime === null || set.maxTime === null) return false;
      // Overlap check: file range intersects with selection range
      return set.minTime <= maxTime && set.maxTime >= minTime;
    });
    
    if (matchingFiles.length === 0) {
      // No exact match, suggest all loaded files (use decoded filenames)
      return {
        files: datasetConfig.sets.map(s => s.decodedFileName || s.fileName),
        suggestion: datasetConfig.sets.map(s => s.decodedFileName || s.fileName).join(' '),
        detected: false,
        note: 'No files match selection time range exactly - showing all loaded files'
      };
    }
    
    // Sort by set number or day number for consistent ordering
    matchingFiles.sort((a, b) => {
      if (a.setNumber !== null && b.setNumber !== null) return a.setNumber - b.setNumber;
      if (a.dayNumber !== null && b.dayNumber !== null) return a.dayNumber - b.dayNumber;
      return a.fileName.localeCompare(b.fileName);
    });
    
    return {
      files: matchingFiles.map(f => f.decodedFileName || f.fileName),
      suggestion: matchingFiles.map(f => f.decodedFileName || f.fileName).join(' '),
      detected: true,
      details: matchingFiles.map(f => ({
        file: f.decodedFileName || f.fileName, // Show decoded filename
        originalFile: f.fileName, // Keep original for reference
        set: f.setNumber,
        day: f.dayNumber,
        timeRange: `${f.minTime} - ${f.maxTime}`,
        records: f.recordCount
      }))
    };
  }

  // Convert selection time to human-readable date range
  // Wrapper functions for decoders that provide global maps
  const _decodeAttack = (value) => decodeAttack(value, attackIdToName);
  const _decodeAttackGroup = (groupVal, fallbackVal) => decodeAttackGroup(groupVal, fallbackVal, attackGroupIdToName, attackIdToName);
  const _lookupAttackColor = (name) => lookupAttackColor(name, rawColorByAttack, colorByAttack);
  const _lookupAttackGroupColor = (name) => lookupAttackGroupColor(name, rawColorByAttackGroup, colorByAttackGroup);

  // Export network data for a specific connected component as CSV
  function exportComponentCSV(compIdx, components, ipToComponent, linksWithNodes, data) {
    if (!components || compIdx < 0 || compIdx >= components.length) {
      console.warn('Invalid component index for export:', compIdx);
      return;
    }

    const componentIps = new Set(components[compIdx]);
    console.log(`Exporting component ${compIdx}: ${componentIps.size} IPs`);

    // Filter links where both source and target belong to this component
    const componentLinks = linksWithNodes.filter(l =>
      componentIps.has(l.sourceNode.name) && componentIps.has(l.targetNode.name)
    );

    if (componentLinks.length === 0) {
      alert(`Component ${compIdx} has no connections to export.`);
      return;
    }

    // Build CSV rows from the component's links
    const csvHeader = 'timestamp,src_ip,dst_ip,count,attack,attack_group,protocol';
    const csvRows = componentLinks.map(l => {
      const ts = l.minute;
      const src = l.sourceIp || l.sourceNode.name;
      const dst = l.targetIp || l.targetNode.name;
      const count = l.count || 1;
      const attack = (l.attack || '').replace(/,/g, ';');
      const attackGroup = (l.attack_group || '').replace(/,/g, ';');
      const protocol = (l.protocol || '').replace(/,/g, ';');
      return `${ts},${src},${dst},${count},${attack},${attackGroup},${protocol}`;
    });

    const csvContent = csvHeader + '\n' + csvRows.join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `component_${compIdx}_network.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    console.log(`Exported component ${compIdx}: ${componentLinks.length} links, ${componentIps.size} IPs`);
  }

  // Generate and display IP communications list after data is loaded
  function generateIPCommunicationsList(data, links, colorForAttack) {
    if (!ipCommList) {
      console.log('IP Communications panel element not found');
      return;
    }

    // Group IP pairs by source file
    const pairsByFile = new Map(); // file -> Set of "src -> dst"

    data.forEach(d => {
      const file = d.sourceFile || 'default';
      const pair = `${d.src_ip} -> ${d.dst_ip}`;

      if (!pairsByFile.has(file)) {
        pairsByFile.set(file, new Set());
      }
      pairsByFile.get(file).add(pair);
    });

    // Build simple output grouped by file
    let html = '';
    const sortedFiles = Array.from(pairsByFile.keys()).sort();

    sortedFiles.forEach(file => {
      const pairs = Array.from(pairsByFile.get(file)).sort();
      html += `<div style="margin-bottom: 16px;">`;
      html += `<div style="font-weight: bold; margin-bottom: 8px; color: #495057;">${file}</div>`;
      pairs.forEach(pair => {
        html += `<div style="padding-left: 16px;">${pair}</div>`;
      });
      html += `</div>`;
    });

    ipCommList.innerHTML = html;

    // Store for export
    currentPairsByFile = pairsByFile;
  }
})();
