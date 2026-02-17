import { initProtected } from './main.js';

document.addEventListener('DOMContentLoaded', () => {
    // 1. Initialize Protected Route
    initProtected();

    // 2. Banner Interaction
    const banner = document.querySelector('.banner-cta');
    const closeBtn = document.querySelector('.cta-close-btn');

    if (banner && closeBtn) {
        closeBtn.addEventListener('click', () => {
            banner.style.opacity = '0';
            setTimeout(() => {
                banner.style.display = 'none';
            }, 300);
        });
    }

    // 3. Floating Input Interaction
    const inputBar = document.querySelector('.floating-input-bar');
    const inputField = document.querySelector('.floating-input-field');
    const actionBtn = document.querySelector('.floating-action-btn');

    if (inputField) {
        inputField.addEventListener('focus', () => {
            inputBar.style.transform = 'translateY(-10px)';
            inputBar.style.boxShadow = '0 10px 40px rgba(0,0,0,0.3)';
        });

        inputField.addEventListener('blur', () => {
            inputBar.style.transform = 'translateY(0)';
            inputBar.style.boxShadow = 'var(--glass-shadow)';
        });

        // Simple Chat Navigation on Enter
        inputField.addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && inputField.value.trim() !== '') {
                // Navigate to chat with query (simulated)
                // Ideally pass as query param, but for now just navigate
                window.location.href = '/chat';
            }
        });
    }

    if (actionBtn) {
        actionBtn.addEventListener('click', () => {
            window.location.href = '/chat';
        });
    }
});
