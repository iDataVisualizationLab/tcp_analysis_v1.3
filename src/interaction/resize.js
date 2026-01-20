// src/interaction/resize.js
// Window resize handler with debouncing

/**
 * Setup window resize handler.
 * @param {Object} options - {debounceMs, onResize}
 * @returns {Function} Cleanup function
 */
export function setupWindowResizeHandler(options) {
    const { debounceMs = 150, onResize } = options;

    let resizeTimeout;

    const handleResize = () => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
            if (onResize) onResize();
        }, debounceMs);
    };

    window.addEventListener('resize', handleResize);

    // Browser zoom detection (Ctrl+wheel)
    const wheelHandler = (event) => {
        if (event.ctrlKey || event.metaKey) {
            setTimeout(handleResize, 100);
        }
    };
    window.addEventListener('wheel', wheelHandler, { passive: true });

    // Keyboard zoom shortcuts
    const keyHandler = (event) => {
        if ((event.ctrlKey || event.metaKey) &&
            (event.key === '+' || event.key === '-' || event.key === '0')) {
            setTimeout(handleResize, 100);
        }
    };
    document.addEventListener('keydown', keyHandler);

    // Return cleanup function
    return () => {
        window.removeEventListener('resize', handleResize);
        window.removeEventListener('wheel', wheelHandler);
        document.removeEventListener('keydown', keyHandler);
        clearTimeout(resizeTimeout);
    };
}
