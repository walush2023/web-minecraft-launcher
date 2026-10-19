package webmc;

import java.lang.reflect.Field;
import java.lang.reflect.Method;

/**
 * Delivers keys that CheerpJ's X11 server cannot represent (Shift, Ctrl, Alt, F1-F12, arrows,
 * Enter, Backspace, Tab, ...) straight into LWJGL 2's keyboard queue.
 *
 * <p>The browser page implements {@link #nextEvent()} in JavaScript (CheerpJ "natives") and
 * resolves it with the next key event, packed as
 * {@code key | down << 8 | repeat << 9 | character << 16}, where {@code key} is an LWJGL
 * {@code Keyboard.KEY_*} code.
 */
final class KeyBridge implements Runnable {
    private Method getImplementation;
    private Field keyboardField;
    private Field keyDownBufferField;
    private Method putKeyboardEvent;
    private Object globalLock;

    private KeyBridge() {
    }

    /** Implemented in JavaScript; resolves with the next packed key event. */
    private static native int nextEvent();

    static void start() {
        Thread thread = new Thread(new KeyBridge(), "webmc-key-bridge");
        thread.setDaemon(true);
        thread.start();
    }

    @Override
    public void run() {
        while (true) {
            int event = nextEvent();
            try {
                inject(event & 0xff, (event & 0x100) != 0, (event & 0x200) != 0, event >>> 16);
            } catch (Throwable t) {
                System.err.println("[webmc] key bridge: " + t);
            }
        }
    }

    private void inject(int key, boolean down, boolean repeat, int character) throws Exception {
        if (getImplementation == null) {
            Class<?> display = Class.forName("org.lwjgl.opengl.Display");
            getImplementation = display.getDeclaredMethod("getImplementation");
            getImplementation.setAccessible(true);
            Field lock = Class.forName("org.lwjgl.opengl.GlobalLock").getDeclaredField("lock");
            lock.setAccessible(true);
            globalLock = lock.get(null);
        }
        Object implementation = getImplementation.invoke(null);
        if (implementation == null) {
            return;
        }
        if (keyboardField == null) {
            keyboardField = implementation.getClass().getDeclaredField("keyboard");
            keyboardField.setAccessible(true);
        }
        Object keyboard = keyboardField.get(implementation);
        if (keyboard == null) {
            return; // Keyboard.create() has not run yet.
        }
        if (putKeyboardEvent == null) {
            Class<?> type = keyboard.getClass();
            keyDownBufferField = type.getDeclaredField("key_down_buffer");
            keyDownBufferField.setAccessible(true);
            putKeyboardEvent = type.getDeclaredMethod("putKeyboardEvent",
                    int.class, byte.class, int.class, long.class, boolean.class);
            putKeyboardEvent.setAccessible(true);
        }
        byte state = (byte) (down ? 1 : 0);
        synchronized (globalLock) {
            byte[] keyDown = (byte[]) keyDownBufferField.get(keyboard);
            keyDown[key] = state;
            putKeyboardEvent.invoke(keyboard, key, state, character, System.nanoTime(), repeat);
        }
    }
}
