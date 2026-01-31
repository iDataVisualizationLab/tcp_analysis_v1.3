// Enhanced visualization loader with folder support
// This file loads the unified bar diagram module and folder integration

let visualizationModule = null;
let folderIntegrationModule = null;

async function loadVisualizationModule() {
    try {
        console.log('Loading unified visualization module...');

        // Add cache-busting parameter to force reload
        const cacheBust = `?v=${Date.now()}`;

        // Load the bar diagram module (it handles both arcs and bars internally)
        visualizationModule = await import(`./ip_bar_diagram.js${cacheBust}`);

        console.log('Successfully loaded visualization module');

        // Initialize the module
        if (visualizationModule.init) {
            visualizationModule.init();
        }

        // Load folder integration module
        console.log('Loading folder integration module...');
        folderIntegrationModule = await import(`./folder_integration.js${cacheBust}`);

        if (folderIntegrationModule.initFolderIntegration) {
            folderIntegrationModule.initFolderIntegration();
        }

        console.log('Successfully loaded folder integration');

    } catch (error) {
        console.error('Failed to load visualization module:', error);
    }
}

function initVisualization() {
    loadVisualizationModule();
}

// Wait for DOM to be ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initVisualization);
} else {
    initVisualization();
}

// Export for potential use by other modules
export { loadVisualizationModule, visualizationModule, folderIntegrationModule };
