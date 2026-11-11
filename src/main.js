import { Game } from './core/Game.js';

// A rebuilt/updated server invalidates the lazily-imported level chunks of an already open
// tab; reload once to pick up the current ones instead of failing the mission build.
window.addEventListener('vite:preloadError', (event) => {
    if (sessionStorage.getItem('wf-chunk-reload')) return;
    sessionStorage.setItem('wf-chunk-reload', '1');
    event.preventDefault();
    location.reload();
});
window.addEventListener('load', () => setTimeout(() => sessionStorage.removeItem('wf-chunk-reload'), 10000));

// Expose for debugging in the console during development.
window.addEventListener('DOMContentLoaded', () => {
    const game = new Game();
    window.__WARFIELD__ = game;
    game.initialize().catch(err => {
        console.error('WARFIELD failed to initialize:', err);
        const status = document.getElementById('loading-status');
        if (status) {
            status.textContent = 'INITIALIZATION ERROR — SEE CONSOLE';
            status.style.color = '#d64545';
        }
    });
});
