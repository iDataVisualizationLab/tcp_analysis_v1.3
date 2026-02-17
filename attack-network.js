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
import { updateFocusRegion } from './src/scales/bifocal.js';
import { createBifocalHandles } from './src/ui/bifocal-handles.js';
import { computeIpSpans, createSpanData, renderRowLines, renderIpLabels, createLabelHoverHandler, createLabelMoveHandler, createLabelLeaveHandler, attachLabelHoverHandlers, renderComponentToggles, updateComponentToggles, showComponentToggles } from './src/rendering/rows.js';
import { createArcHoverHandler, createArcMoveHandler, createArcLeaveHandler, attachArcHandlers } from './src/rendering/arcInteractions.js';
import { loadAllMappings } from './src/mappings/loaders.js';
import { setupWindowResizeHandler as setupWindowResizeHandlerFromModule } from './src/interaction/resize.js';
import { ForceNetworkLayout } from './src/layout/force_network.js';
import { TimearcsLayout } from './src/layout/timearcs_layout.js';

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
  let timearcsLayout = null;   // TimearcsLayout instance
  let layoutTransitionInProgress = false; // Guard against rapid switching
  
  // Timestamp information (needed for export)
  let currentTimeInfo = null; // Stores {unit, looksAbsolute, unitMs, base, activeLabelKey}
  // (Brush selection, persistent selections, component expansion, and drag state
  //  are all owned by TimearcsLayout — access via timearcsLayout.getPersistentSelections() etc.)

  // Dataset configuration: maps time ranges to data files
  // This will be populated based on loaded data or can be configured manually
  let datasetConfig = {
    // Time is in the data's native unit (e.g., minutes since epoch)
    // Will be auto-detected from loaded files or can be set manually
    sets: [],
    baseDataPath: './',  // Base path for data files
    ipMapPath: './full_ip_map.json',  // Default IP map path
    autoDetected: false,
    // Path to multi-resolution data for tcp-analysis detail view
    // This should point to a folder with manifest.json compatible with tcp-analysis
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
      const ratio = parseFloat(e.target.value);
      compressionValue.textContent = `${ratio}x`;
      if (timearcsLayout) {
        timearcsLayout.updateBifocalCompression(ratio);
      }
    });
  }

  // Handle keyboard shortcuts for bifocal navigation
  document.addEventListener('keydown', (e) => {
    // Arrow keys: navigate bifocal focus
    if (e.key.startsWith('Arrow') && timearcsLayout) {
      const step = e.shiftKey ? 0.1 : 0.02; // Shift for large steps
      const state = timearcsLayout.getBifocalState();
      const focusSpan = state.focusEnd - state.focusStart;

      let newState = null;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        const newStart = Math.max(0, state.focusStart - step);
        newState = updateFocusRegion(state, newStart, newStart + focusSpan);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        const newEnd = Math.min(1, state.focusEnd + step);
        newState = updateFocusRegion(state, newEnd - focusSpan, newEnd);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const expandStep = step / 2;
        newState = updateFocusRegion(
          state,
          Math.max(0, state.focusStart - expandStep),
          Math.min(1, state.focusEnd + expandStep)
        );
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        const contractStep = step / 2;
        const center = (state.focusStart + state.focusEnd) / 2;
        const newSpan = Math.max(0.05, focusSpan - contractStep * 2);
        newState = updateFocusRegion(state, center - newSpan / 2, center + newSpan / 2);
      }

      if (newState) {
        timearcsLayout.setBifocalState(newState);
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
      } else if (timearcsLayout) {
        timearcsLayout.clearBrushSelection();
      }
    });
  }


  let width = DEFAULT_WIDTH; // updated on render
  let height = DEFAULT_HEIGHT; // updated on render

  // (Bifocal state, cached layout, and render generation are now owned by TimearcsLayout)

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
  let currentLabelMode = 'timearcs'; // Track current label mode for filtering

  // Store original unfiltered data for legend filtering and resize re-render
  let originalData = null;
  // Flag to track if we're rendering filtered data (to prevent overwriting originalData)
  let isRenderingFilteredData = false;
  // Cleanup function for resize handler
  let resizeCleanup = null;

  // Render context is now retrieved via timearcsLayout.getContext() instead of _render* vars

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
          width = newWidth; // Update module-level width for brush extent
          forceLayout.width = newWidth + MARGIN.left + MARGIN.right;
          forceLayout.height = height;
          if (forceLayoutLayer) {
            forceLayout.render(forceLayoutLayer);
          }
          // Redraw persistent selections at new node positions
          if (timearcsLayout && timearcsLayout.getPersistentSelections().length > 0) {
            timearcsLayout.redrawPersistentSelections();
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

      // Clear selection and UI state
      visibleAttacks.clear();
      currentPairsByFile = null;

      // Destroy timearcsLayout (clears selections, arcs, DOM references)
      if (timearcsLayout) {
        timearcsLayout.destroy();
        timearcsLayout = null;
      }

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

    // Destroy timearcsLayout (clears selections, arcs, DOM references)
    if (timearcsLayout) {
      timearcsLayout.destroy();
      timearcsLayout = null;
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
    if (!timearcsLayout?._attacks || !timearcsLayout?._arcPaths) {
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
    timearcsLayout._arcPaths.attr('data-attack', d => d[activeLabelKey] || 'normal');

    // 2. Update gradient colors
    svg.selectAll('linearGradient').each(function(d) {
      const grad = d3.select(this);
      grad.select('stop:first-child')
        .attr('stop-color', colorForAttack(d[activeLabelKey] || 'normal'));
    });

    // 3. Rebuild legend with new attack list
    const attacks = Array.from(new Set(timearcsLayout._attacks.map(l => l[activeLabelKey] || 'normal'))).sort();

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
    const ctx = timearcsLayout ? timearcsLayout.getContext() : {};
    if (!ctx.linksWithNodes || ctx.linksWithNodes.length === 0) {
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
    for (const ip of ctx.allIps) {
      const yPos = ctx.yScaleLens ? ctx.yScaleLens(ip) : MARGIN.top + 50;
      initialPositions.set(ip, { x: centerX, y: yPos });
    }

    // Create force layout and pre-calculate final positions (run simulation to completion)
    forceLayout = new ForceNetworkLayout({
      d3, svg, width, height, margin: MARGIN,
      colorForAttack, tooltip, showTooltip, hideTooltip
    });
    forceLayout.setData(
      ctx.linksWithNodes, ctx.allIps,
      ctx.ipToComponent, ctx.components, activeLabelKey
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
      ctx.linksWithNodes.map(l => l[activeLabelKey] || 'normal')
    )).sort();
    visibleAttacks = new Set(attacks);
    currentLabelMode = labelMode;
    buildLegend(attacks, colorForAttack);

    // Hide compression slider (magnification not applicable in force mode)
    if (compressionSlider) compressionSlider.closest('div').style.display = 'none';

    layoutTransitionInProgress = false;
    setStatus(statusEl, `Force layout: ${ctx.allIps.length} IPs • ${attacks.length} attack groups`);
  }

  // Show force layout directly without animation (used on initial load when force layout is default)
  function showForceLayoutDirectly() {
    const ctx = timearcsLayout ? timearcsLayout.getContext() : {};
    if (!ctx.linksWithNodes || ctx.linksWithNodes.length === 0) {
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
    for (const ip of ctx.allIps) {
      const yPos = ctx.yScaleLens ? ctx.yScaleLens(ip) : MARGIN.top + 50;
      initialPositions.set(ip, { x: centerX, y: yPos });
    }

    // Create force layout
    forceLayout = new ForceNetworkLayout({
      d3, svg, width, height, margin: MARGIN,
      colorForAttack, tooltip, showTooltip, hideTooltip
    });
    forceLayout.setData(
      ctx.linksWithNodes, ctx.allIps,
      ctx.ipToComponent, ctx.components, activeLabelKey
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
      ctx.linksWithNodes.map(l => l[activeLabelKey] || 'normal')
    )).sort();
    visibleAttacks = new Set(attacks);
    currentLabelMode = labelMode;
    buildLegend(attacks, colorForAttack);

    // Hide compression slider
    if (compressionSlider) compressionSlider.closest('div').style.display = 'none';

    setStatus(statusEl, `Force layout: ${ctx.allIps.length} IPs • ${attacks.length} attack groups`);
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
        const ctx = timearcsLayout ? timearcsLayout.getContext() : {};
        const arcX = ctx.xScaleLens ? ctx.xScaleLens(d.minute) : MARGIN.left;
        const srcY = ctx.yScaleLens ? ctx.yScaleLens(srcIp) : MARGIN.top + 50;
        const tgtY = ctx.yScaleLens ? ctx.yScaleLens(tgtIp) : MARGIN.top + 100;
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
    if (timearcsLayout && timearcsLayout._cachedDynamicHeight) {
      svg.attr('height', timearcsLayout._cachedDynamicHeight);
    }

    // Refresh timearcs positions to match current bifocal state
    if (timearcsLayout) {
      timearcsLayout.setBifocalState(timearcsLayout.getBifocalState());
    }

    // Rebuild legend for timearcs mode
    if (timearcsLayout && timearcsLayout._attacks) {
      const attacks = timearcsLayout._attacks;
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
    // Store original data for filtering/resize (only if this is truly new data)
    if (!isRenderingFilteredData && (!originalData || visibleAttacks.size === 0)) {
      originalData = data;
      console.log('Stored original data:', originalData.length, 'records');
    }

    // Create timearcsLayout instance once (survives filtered re-renders)
    if (!timearcsLayout) {
      timearcsLayout = new TimearcsLayout({
        svg, container, tooltip,
        width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT,
        colorForAttack: (name) => _lookupAttackColor(name) || _lookupAttackGroupColor(name) || DEFAULT_COLOR,
        getLabelMode: () => labelMode,
        getLayoutMode: () => layoutMode,
        getForceLayout: () => forceLayout,
        onRenderComplete: (ctx) => {
          // Sync time info needed by openDetailsInNewTab
          currentTimeInfo = {
            unit: timearcsLayout._unit,
            looksAbsolute: timearcsLayout._looksAbsolute,
            unitMs: timearcsLayout._unitMs,
            unitSuffix: timearcsLayout._unitSuffix,
            base: timearcsLayout._base,
            activeLabelKey: labelMode === 'force_layout' ? 'attack_group' : 'attack'
          };
          // Sync dimensions used by transition functions
          width = timearcsLayout._width;
          height = timearcsLayout._height;
          // Rebuild legend with attacks from this render
          const attacks = timearcsLayout._attacks || [];
          visibleAttacks = new Set(attacks);
          currentLabelMode = labelMode;
          buildLegend(attacks, ctx.colorForAttack);
          // Show force layout on initial load when it is the default mode
          if (layoutMode === 'force_layout' && !forceLayout) {
            showForceLayoutDirectly();
          }
        },
        onDetailsRequested: (selection) => openDetailsInNewTab(selection),
        onSelectionChange: null,
        statusEl,
        bifocalRegionText
      });
    }

    await timearcsLayout.render(data, isRenderingFilteredData, originalData);
  }

  function openDetailsInNewTab(selection) {
      if (!selection) return;
      const selArcs = selection.arcs;
      const selIps = selection.ips;
      const selTimeRange = selection.timeRange;
      const selId = selection.id;

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

      // Prepare data for tcp-analysis
      // Filter (timearcsLayout ? timearcsLayout.getCurrentSortedIps() : []) to only include selected IPs, preserving vertical order
      const selIpsSet = selIps instanceof Set ? selIps : new Set(selIps);
      const orderedSelectedIps = (timearcsLayout ? timearcsLayout.getCurrentSortedIps() : []).filter(ip => selIpsSet.has(ip));

      // Get files covering the selection time range
      const fileDetection = getFilesForTimeRange(selTimeRange.min, selTimeRange.max);

      // Build dataFiles array from detected files or all loaded files
      const dataFiles = fileDetection.detected
        ? fileDetection.files
        : (datasetConfig.sets || []).map(s => s.decodedFileName || s.fileName);

      // Get file paths for loading (use filePath from sets if available)
      const filePaths = (datasetConfig.sets || []).map(s => s.filePath).filter(Boolean);

      const selectionData = {
        source: 'attack_network_brush_selection',
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
        // Path to multi-resolution data for tcp-analysis (compatible format)
        detailViewDataPath: datasetConfig.detailViewDataPath || null,
        ipMapPath: datasetConfig.ipMapPath || null
      };

      // Store in localStorage for the new tab to read
      // Note: Using localStorage instead of sessionStorage because sessionStorage is tab-scoped
      // and doesn't persist when opening a new tab with window.open()
      try {
        localStorage.setItem(storageKey, JSON.stringify(selectionData));
        console.log(`Stored brush selection #${selId} data for tcp-analysis:`, selectionData);
        console.log(`localStorage key: ${storageKey}`);
      } catch (e) {
        console.error('Failed to store selection data:', e);
        alert('Failed to store selection data. The data might be too large.');
        return;
      }

      // Open tcp-analysis in a new tab with the storage key as parameter
      // The page will read the fromSelection parameter to get data from localStorage
      const encodedKey = encodeURIComponent(storageKey);
      const newTabUrl = `./tcp-analysis.html?fromSelection=${encodedKey}`;

      console.log(`Opening tcp-analysis with URL: ${newTabUrl}`);
      console.log(`Full URL will be: ${new URL(newTabUrl, window.location.href).href}`);

      const newWindow = window.open(newTabUrl, '_blank');
      if (!newWindow) {
        // Popup might be blocked, try alternative approach
        console.warn('Popup blocked, trying location navigation');
        alert('Popup was blocked. Please allow popups for this site, or use Ctrl+Click on the View Details button.');
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
