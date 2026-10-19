package webmc.jdk.concurrent;

/**
 * Stand-in for {@code java.util.concurrent.atomic.AtomicBoolean} in the game's classes (see
 * {@code webmc.StandIns}): Java 17 runs compareAndSet and getAndSet through a VarHandle, which
 * CheerpJ makes slow (see {@link AtomicReferenceArray}). Netty extends this class, so it stays
 * open with final methods, as in the JDK.
 */
public class AtomicBoolean implements java.io.Serializable {
    private static final long serialVersionUID = 4654671469794556979L;

    private volatile int value;

    public AtomicBoolean(boolean initialValue) {
        value = initialValue ? 1 : 0;
    }

    public AtomicBoolean() {
    }

    public final boolean get() {
        return value != 0;
    }

    public final boolean compareAndSet(boolean expectedValue, boolean newValue) {
        synchronized (this) {
            if ((value != 0) != expectedValue) {
                return false;
            }
            value = newValue ? 1 : 0;
            return true;
        }
    }

    @Deprecated
    public boolean weakCompareAndSet(boolean expectedValue, boolean newValue) {
        return compareAndSet(expectedValue, newValue);
    }

    public boolean weakCompareAndSetPlain(boolean expectedValue, boolean newValue) {
        return compareAndSet(expectedValue, newValue);
    }

    public final void set(boolean newValue) {
        value = newValue ? 1 : 0;
    }

    public final void lazySet(boolean newValue) {
        value = newValue ? 1 : 0;
    }

    public final boolean getAndSet(boolean newValue) {
        synchronized (this) {
            boolean old = value != 0;
            value = newValue ? 1 : 0;
            return old;
        }
    }

    @Override
    public String toString() {
        return Boolean.toString(get());
    }

    public final boolean getPlain() {
        return value != 0;
    }

    public final void setPlain(boolean newValue) {
        value = newValue ? 1 : 0;
    }

    public final boolean getOpaque() {
        return value != 0;
    }

    public final void setOpaque(boolean newValue) {
        value = newValue ? 1 : 0;
    }

    public final boolean getAcquire() {
        return value != 0;
    }

    public final void setRelease(boolean newValue) {
        value = newValue ? 1 : 0;
    }

    public final boolean compareAndExchange(boolean expectedValue, boolean newValue) {
        synchronized (this) {
            boolean current = value != 0;
            if (current == expectedValue) {
                value = newValue ? 1 : 0;
            }
            return current;
        }
    }

    public final boolean compareAndExchangeAcquire(boolean expectedValue, boolean newValue) {
        return compareAndExchange(expectedValue, newValue);
    }

    public final boolean compareAndExchangeRelease(boolean expectedValue, boolean newValue) {
        return compareAndExchange(expectedValue, newValue);
    }

    public boolean weakCompareAndSetVolatile(boolean expectedValue, boolean newValue) {
        return compareAndSet(expectedValue, newValue);
    }

    public boolean weakCompareAndSetAcquire(boolean expectedValue, boolean newValue) {
        return compareAndSet(expectedValue, newValue);
    }

    public boolean weakCompareAndSetRelease(boolean expectedValue, boolean newValue) {
        return compareAndSet(expectedValue, newValue);
    }
}
