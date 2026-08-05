# Accessibility Requirements

This project must support screen reader users.

Primary users:
- JAWS on Windows
- NVDA on Windows

Avoid relying only on canvas-based UI.
Provide equivalent HTML controls when possible.

Terminal accessibility:
- xterm.js is for visual terminal users.
- HTML controls should be provided for screen reader workflows.
- Keyboard navigation must work without a mouse.
- Announcements should use aria-live when appropriate.

Test changes with keyboard-only navigation.