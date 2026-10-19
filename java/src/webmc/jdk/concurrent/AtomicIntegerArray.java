package webmc.jdk.concurrent;

import java.util.function.IntBinaryOperator;
import java.util.function.IntUnaryOperator;

/**
 * Stand-in for {@code java.util.concurrent.atomic.AtomicIntegerArray} in the game's classes (see
 * {@code webmc.StandIns}): Java 17 reaches every element through a VarHandle, which CheerpJ makes
 * slow (see {@link AtomicReferenceArray}).
 */
public class AtomicIntegerArray implements java.io.Serializable {
    private static final long serialVersionUID = 2862133569453604235L;

    private final int[] array;

    public AtomicIntegerArray(int length) {
        array = new int[length];
    }

    public AtomicIntegerArray(int[] array) {
        this.array = array.clone();
    }

    public final int length() {
        return array.length;
    }

    public final int get(int i) {
        return array[i];
    }

    public final void set(int i, int newValue) {
        array[i] = newValue;
    }

    public final void lazySet(int i, int newValue) {
        array[i] = newValue;
    }

    public final int getAndSet(int i, int newValue) {
        synchronized (array) {
            int old = array[i];
            array[i] = newValue;
            return old;
        }
    }

    public final boolean compareAndSet(int i, int expectedValue, int newValue) {
        synchronized (array) {
            if (array[i] != expectedValue) {
                return false;
            }
            array[i] = newValue;
            return true;
        }
    }

    @Deprecated
    public final boolean weakCompareAndSet(int i, int expectedValue, int newValue) {
        return compareAndSet(i, expectedValue, newValue);
    }

    public final boolean weakCompareAndSetPlain(int i, int expectedValue, int newValue) {
        return compareAndSet(i, expectedValue, newValue);
    }

    public final int getAndIncrement(int i) {
        return getAndAdd(i, 1);
    }

    public final int getAndDecrement(int i) {
        return getAndAdd(i, -1);
    }

    public final int getAndAdd(int i, int delta) {
        synchronized (array) {
            int old = array[i];
            array[i] = old + delta;
            return old;
        }
    }

    public final int incrementAndGet(int i) {
        return addAndGet(i, 1);
    }

    public final int decrementAndGet(int i) {
        return addAndGet(i, -1);
    }

    public final int addAndGet(int i, int delta) {
        synchronized (array) {
            return array[i] += delta;
        }
    }

    public final int getAndUpdate(int i, IntUnaryOperator updateFunction) {
        int prev = get(i);
        int next = 0;
        for (boolean haveNext = false;;) {
            if (!haveNext) {
                next = updateFunction.applyAsInt(prev);
            }
            if (compareAndSet(i, prev, next)) {
                return prev;
            }
            haveNext = (prev == (prev = get(i)));
        }
    }

    public final int updateAndGet(int i, IntUnaryOperator updateFunction) {
        int prev = get(i);
        int next = 0;
        for (boolean haveNext = false;;) {
            if (!haveNext) {
                next = updateFunction.applyAsInt(prev);
            }
            if (compareAndSet(i, prev, next)) {
                return next;
            }
            haveNext = (prev == (prev = get(i)));
        }
    }

    public final int getAndAccumulate(int i, int x, IntBinaryOperator accumulatorFunction) {
        int prev = get(i);
        int next = 0;
        for (boolean haveNext = false;;) {
            if (!haveNext) {
                next = accumulatorFunction.applyAsInt(prev, x);
            }
            if (compareAndSet(i, prev, next)) {
                return prev;
            }
            haveNext = (prev == (prev = get(i)));
        }
    }

    public final int accumulateAndGet(int i, int x, IntBinaryOperator accumulatorFunction) {
        int prev = get(i);
        int next = 0;
        for (boolean haveNext = false;;) {
            if (!haveNext) {
                next = accumulatorFunction.applyAsInt(prev, x);
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

    public final int getPlain(int i) {
        return array[i];
    }

    public final void setPlain(int i, int newValue) {
        array[i] = newValue;
    }

    public final int getOpaque(int i) {
        return array[i];
    }

    public final void setOpaque(int i, int newValue) {
        array[i] = newValue;
    }

    public final int getAcquire(int i) {
        return array[i];
    }

    public final void setRelease(int i, int newValue) {
        array[i] = newValue;
    }

    public final int compareAndExchange(int i, int expectedValue, int newValue) {
        synchronized (array) {
            int current = array[i];
            if (current == expectedValue) {
                array[i] = newValue;
            }
            return current;
        }
    }

    public final int compareAndExchangeAcquire(int i, int expectedValue, int newValue) {
        return compareAndExchange(i, expectedValue, newValue);
    }

    public final int compareAndExchangeRelease(int i, int expectedValue, int newValue) {
        return compareAndExchange(i, expectedValue, newValue);
    }

    public final boolean weakCompareAndSetVolatile(int i, int expectedValue, int newValue) {
        return compareAndSet(i, expectedValue, newValue);
    }

    public final boolean weakCompareAndSetAcquire(int i, int expectedValue, int newValue) {
        return compareAndSet(i, expectedValue, newValue);
    }

    public final boolean weakCompareAndSetRelease(int i, int expectedValue, int newValue) {
        return compareAndSet(i, expectedValue, newValue);
    }
}
