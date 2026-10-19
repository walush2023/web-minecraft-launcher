package webmc.jdk.concurrent;

import java.util.function.LongBinaryOperator;
import java.util.function.LongUnaryOperator;

/**
 * Stand-in for {@code java.util.concurrent.atomic.AtomicLongArray} in the game's classes (see
 * {@code webmc.StandIns}): Java 17 reaches every element through a VarHandle, which CheerpJ makes
 * slow (see {@link AtomicReferenceArray}).
 */
public class AtomicLongArray implements java.io.Serializable {
    private static final long serialVersionUID = -2308431214976778248L;

    private final long[] array;

    public AtomicLongArray(int length) {
        array = new long[length];
    }

    public AtomicLongArray(long[] array) {
        this.array = array.clone();
    }

    public final int length() {
        return array.length;
    }

    public final long get(int i) {
        return array[i];
    }

    public final void set(int i, long newValue) {
        array[i] = newValue;
    }

    public final void lazySet(int i, long newValue) {
        array[i] = newValue;
    }

    public final long getAndSet(int i, long newValue) {
        synchronized (array) {
            long old = array[i];
            array[i] = newValue;
            return old;
        }
    }

    public final boolean compareAndSet(int i, long expectedValue, long newValue) {
        synchronized (array) {
            if (array[i] != expectedValue) {
                return false;
            }
            array[i] = newValue;
            return true;
        }
    }

    @Deprecated
    public final boolean weakCompareAndSet(int i, long expectedValue, long newValue) {
        return compareAndSet(i, expectedValue, newValue);
    }

    public final boolean weakCompareAndSetPlain(int i, long expectedValue, long newValue) {
        return compareAndSet(i, expectedValue, newValue);
    }

    public final long getAndIncrement(int i) {
        return getAndAdd(i, 1);
    }

    public final long getAndDecrement(int i) {
        return getAndAdd(i, -1);
    }

    public final long getAndAdd(int i, long delta) {
        synchronized (array) {
            long old = array[i];
            array[i] = old + delta;
            return old;
        }
    }

    public final long incrementAndGet(int i) {
        return addAndGet(i, 1);
    }

    public final long decrementAndGet(int i) {
        return addAndGet(i, -1);
    }

    public final long addAndGet(int i, long delta) {
        synchronized (array) {
            return array[i] += delta;
        }
    }

    public final long getAndUpdate(int i, LongUnaryOperator updateFunction) {
        long prev = get(i);
        long next = 0;
        for (boolean haveNext = false;;) {
            if (!haveNext) {
                next = updateFunction.applyAsLong(prev);
            }
            if (compareAndSet(i, prev, next)) {
                return prev;
            }
            haveNext = (prev == (prev = get(i)));
        }
    }

    public final long updateAndGet(int i, LongUnaryOperator updateFunction) {
        long prev = get(i);
        long next = 0;
        for (boolean haveNext = false;;) {
            if (!haveNext) {
                next = updateFunction.applyAsLong(prev);
            }
            if (compareAndSet(i, prev, next)) {
                return next;
            }
            haveNext = (prev == (prev = get(i)));
        }
    }

    public final long getAndAccumulate(int i, long x, LongBinaryOperator accumulatorFunction) {
        long prev = get(i);
        long next = 0;
        for (boolean haveNext = false;;) {
            if (!haveNext) {
                next = accumulatorFunction.applyAsLong(prev, x);
            }
            if (compareAndSet(i, prev, next)) {
                return prev;
            }
            haveNext = (prev == (prev = get(i)));
        }
    }

    public final long accumulateAndGet(int i, long x, LongBinaryOperator accumulatorFunction) {
        long prev = get(i);
        long next = 0;
        for (boolean haveNext = false;;) {
            if (!haveNext) {
                next = accumulatorFunction.applyAsLong(prev, x);
            }
            if (compareAndSet(i, prev, next)) {
                return next;
            }
            haveNext = (prev == (prev = get(i)));
        }
    }

    @Override
    public String toString() {
        int iMax = array.length - 1;
        if (iMax == -1) {
            return "[]";
        }
        StringBuilder b = new StringBuilder();
        b.append('[');
        for (int i = 0;; i++) {
            b.append(get(i));
            if (i == iMax) {
                return b.append(']').toString();
            }
            b.append(',').append(' ');
        }
    }

    public final long getPlain(int i) {
        return array[i];
    }

    public final void setPlain(int i, long newValue) {
        array[i] = newValue;
    }

    public final long getOpaque(int i) {
        return array[i];
    }

    public final void setOpaque(int i, long newValue) {
        array[i] = newValue;
    }

    public final long getAcquire(int i) {
        return array[i];
    }

    public final void setRelease(int i, long newValue) {
        array[i] = newValue;
    }

    public final long compareAndExchange(int i, long expectedValue, long newValue) {
        synchronized (array) {
            long current = array[i];
            if (current == expectedValue) {
                array[i] = newValue;
            }
            return current;
        }
    }

    public final long compareAndExchangeAcquire(int i, long expectedValue, long newValue) {
        return compareAndExchange(i, expectedValue, newValue);
    }

    public final long compareAndExchangeRelease(int i, long expectedValue, long newValue) {
        return compareAndExchange(i, expectedValue, newValue);
    }

    public final boolean weakCompareAndSetVolatile(int i, long expectedValue, long newValue) {
        return compareAndSet(i, expectedValue, newValue);
    }

    public final boolean weakCompareAndSetAcquire(int i, long expectedValue, long newValue) {
        return compareAndSet(i, expectedValue, newValue);
    }

    public final boolean weakCompareAndSetRelease(int i, long expectedValue, long newValue) {
        return compareAndSet(i, expectedValue, newValue);
    }
}
