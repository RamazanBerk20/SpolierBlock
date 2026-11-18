package dev.spoilerblock;

import android.view.ActionMode;
import android.view.KeyEvent;
import android.view.Menu;
import android.view.MenuItem;
import android.view.MotionEvent;
import android.view.SearchEvent;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityEvent;

/** Window.Callback wrapper: sees every touch of the activity window before the app does (see Scanner.onTouch). */
final class TouchGate implements Window.Callback {
    private final Window.Callback app;
    private final Scanner scanner;

    TouchGate(Window.Callback app, Scanner scanner) {
        this.app = app;
        this.scanner = scanner;
    }

    void toApp(MotionEvent ev) { app.dispatchTouchEvent(ev); }

    @Override public boolean dispatchTouchEvent(MotionEvent ev) {
        if (!SpoilerBlock.dead) {
            try {
                if (ev.getActionMasked() == MotionEvent.ACTION_UP) scanner.sb.watchWindows(); // a tap may open a dialog or popup
                if (scanner.onTouch(this, ev)) return true;
            } catch (Throwable t) {
                SpoilerBlock.fail("touch", t);
            }
        }
        return app.dispatchTouchEvent(ev);
    }

    @Override public boolean dispatchKeyEvent(KeyEvent e) {
        if (!SpoilerBlock.dead) try { scanner.sb.watchWindows(); } catch (Throwable t) { SpoilerBlock.fail("key", t); } // typing opens suggestions
        return app.dispatchKeyEvent(e);
    }
    @Override public boolean dispatchKeyShortcutEvent(KeyEvent e) { return app.dispatchKeyShortcutEvent(e); }
    @Override public boolean dispatchTrackballEvent(MotionEvent e) { return app.dispatchTrackballEvent(e); }
    @Override public boolean dispatchGenericMotionEvent(MotionEvent e) { return app.dispatchGenericMotionEvent(e); }
    @Override public boolean dispatchPopulateAccessibilityEvent(AccessibilityEvent e) { return app.dispatchPopulateAccessibilityEvent(e); }
    @Override public View onCreatePanelView(int f) { return app.onCreatePanelView(f); }
    @Override public boolean onCreatePanelMenu(int f, Menu m) { return app.onCreatePanelMenu(f, m); }
    @Override public boolean onPreparePanel(int f, View v, Menu m) { return app.onPreparePanel(f, v, m); }
    @Override public boolean onMenuOpened(int f, Menu m) { return app.onMenuOpened(f, m); }
    @Override public boolean onMenuItemSelected(int f, MenuItem i) { return app.onMenuItemSelected(f, i); }
    @Override public void onWindowAttributesChanged(WindowManager.LayoutParams p) { app.onWindowAttributesChanged(p); }
    @Override public void onContentChanged() { app.onContentChanged(); }
    @Override public void onWindowFocusChanged(boolean f) { app.onWindowFocusChanged(f); }
    @Override public void onAttachedToWindow() { app.onAttachedToWindow(); }
    @Override public void onDetachedFromWindow() { app.onDetachedFromWindow(); }
    @Override public void onPanelClosed(int f, Menu m) { app.onPanelClosed(f, m); }
    @Override public boolean onSearchRequested() { return app.onSearchRequested(); }
    @Override public boolean onSearchRequested(SearchEvent e) { return app.onSearchRequested(e); }
    @Override public ActionMode onWindowStartingActionMode(ActionMode.Callback c) { return app.onWindowStartingActionMode(c); }
    @Override public ActionMode onWindowStartingActionMode(ActionMode.Callback c, int t) { return app.onWindowStartingActionMode(c, t); }
    @Override public void onActionModeStarted(ActionMode m) { app.onActionModeStarted(m); }
    @Override public void onActionModeFinished(ActionMode m) { app.onActionModeFinished(m); }
    @Override public void onPointerCaptureChanged(boolean c) { app.onPointerCaptureChanged(c); }
    @Override public void onProvideKeyboardShortcuts(java.util.List<android.view.KeyboardShortcutGroup> d, Menu m, int id) { app.onProvideKeyboardShortcuts(d, m, id); }
}
