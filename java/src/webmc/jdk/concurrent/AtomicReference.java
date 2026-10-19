package webmc.jdk.concurrent;

import java.util.function.BinaryOperator;
import java.util.function.UnaryOperator;

/**
 * Stand-in for {@code java.util.concurrent.atomic.AtomicReference} in the game's classes (see
 * {@code webmc.StandIns}): Java 17 runs compareAndSet, getAndSet and the update methods through
 * a VarHandle, which CheerpJ makes slow (see {@link AtomicReferenceArray}). Libraries extend this
 * class (Guava, Netty), so it stays open with final methods, as in the JDK.
 */
public class AtomicReference<V> implements java.io.Serializable {
    private static final long serialVersionUID = -1848883965231344442L;

    private volatile V value;

    public AtomicReference(V initialValue) {
        value = initialValue;
    }

    public AtomicReference() {
    }

    public final V get() {
        return value;
    }

    public final void set(V newValue) {
        value = newValue;
    }

    public final void lazySet(V newValue) {
        value = newValue;
    }

    public final boolean compareAndSet(V expectedValue, V newValue) {
        synchronized (this) {
            if (value != expectedValue) {
                return false;
            }
            value = newValue;
            return true;
        }
    }

    @Deprecated
    public final boolean weakCompareAndSet(V expectedValue, V newValue) {
        return compareAndSet(expectedValue, newValue);
    }

    public final boolean weakCompareAndSetPlain(V expectedValue, V newValue) {
        return compareAndSet(expectedValue, newValue);
    }

    public final V getAndSet(V newValue) {
        synchronized (this) {
            V old = value;
            value = newValue;
            return old;
        }
    }

    public final V getAndUpdate(UnaryOperator<V> updateFunction) {
        V prev = get();
        V next = null;
        for (boolean haveNext = false;;) {
            if (!haveNext) {
                next = updateFunction.apply(prev);
            }
            if (compareAndSet(prev, next)) {
                return prev;
            }
            haveNext = (prev == (prev = get()));
        }
    }

    public final V updateAndGet(UnaryOperator<V> updateFunction) {
        V prev = get();
        V next = null;
        for (boolean haveNext = false;;) {
            if (!haveNext) {
                next = updateFunction.apply(prev);
            }
            if (compareAndSet(prev, next)) {
                return next;
            }
            haveNext = (prev == (prev = get()));
        }
    }

    public final V getAndAccumulate(V x, BinaryOperator<V> accumulatorFunction) {
        V prev = get();
        V next = null;
        for (boolean haveNext = false;;) {
            if (!haveNext) {
                next = accumulatorFunction.apply(prev, x);
            }
            if (compareAndSet(prev, next)) {
                return prev;
            }
            haveNext = (prev == (prev = get()));
        }
    }

    public final V accumulateAndGet(V x, BinaryOperator<V> accumulatorFunction) {
        V prev = get();
        V next = null;
        for (boolean haveNext = false;;) {
            if (!haveNext) {
                next = accumulatorFunction.apply(prev, x);
            }
            if (compareAndSet(prev, next)) {
                return next;
            }
            haveNext = (prev == (prev = get()));
        }
    }

    @Override
    public String toString() {
        return String.valueOf(get());
    }

    public final V getPlain() {
        return value;
    }

    public final void setPlain(V newValue) {
        value = newValue;
    }

    public final V getOpaque() {
        return value;
    }

    public final void setOpaque(V newValue) {
        value = newValue;
    }

    public final V getAcquire() {
        return value;
    }

    public final void setRelease(V newValue) {
        value = newValue;
    }

    public final V compareAndExchange(V expectedValue, V newValue) {
        synchronized (this) {
            V current = value;
            if (current == expectedValue) {
                value = newValue;
            }
            return current;
        }
    }

    public final V compareAndExchangeAcquire(V expectedValue, V newValue) {
        return compareAndExchange(expectedValue, newValue);
    }

    public final V compareAndExchangeRelease(V expectedValue, V newValue) {
        return compareAndExchange(expectedValue, newValue);
    }

    public final boolean weakCompareAndSetVolatile(V expectedValue, V newValue) {
        return compareAndSet(expectedValue, newValue);
    }

    public final boolean weakCompareAndSetAcquire(V expectedValue, V newValue) {
        return compareAndSet(expectedValue, newValue);
    }

    public final boolean weakCompareAndSetRelease(V expectedValue, V newValue) {
        return compareAndSet(expectedValue, newValue);
    }
}
