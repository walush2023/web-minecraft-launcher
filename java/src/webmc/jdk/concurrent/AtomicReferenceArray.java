package webmc.jdk.concurrent;

import java.util.Arrays;
import java.util.function.BinaryOperator;
import java.util.function.UnaryOperator;

/**
 * Stand-in for {@code java.util.concurrent.atomic.AtomicReferenceArray} in the game's classes
 * (see {@code webmc.StandIns}). Java 17's implementation reads and writes every element through a
 * VarHandle, and CheerpJ runs each VarHandle access through a newly bound MethodHandle, which
 * costs tens of microseconds; the client looks chunks up this way for every block it reads.
 *
 * <p>CheerpJ runs all Java threads on the browser's thread and switches only when one blocks, so
 * plain element accesses are atomic and visible to every thread. The read-modify-write methods
 * hold the array's monitor all the same.
 */
public class AtomicReferenceArray<E> implements java.io.Serializable {
    private static final long serialVersionUID = -6209656149925076980L;

    private final Object[] array;

    public AtomicReferenceArray(int length) {
        array = new Object[length];
    }

    public AtomicReferenceArray(E[] array) {
        this.array = Arrays.copyOf(array, array.length, Object[].class);
    }

    public final int length() {
        return array.length;
    }

    @SuppressWarnings("unchecked")
    public final E get(int i) {
        return (E) array[i];
    }

    public final void set(int i, E newValue) {
        array[i] = newValue;
    }

    public final void lazySet(int i, E newValue) {
        array[i] = newValue;
    }

    @SuppressWarnings("unchecked")
    public final E getAndSet(int i, E newValue) {
        synchronized (array) {
            Object old = array[i];
            array[i] = newValue;
            return (E) old;
        }
    }

    public final boolean compareAndSet(int i, E expectedValue, E newValue) {
        synchronized (array) {
            if (array[i] != expectedValue) {
                return false;
            }
            array[i] = newValue;
            return true;
        }
    }

    @Deprecated
    public final boolean weakCompareAndSet(int i, E expectedValue, E newValue) {
        return compareAndSet(i, expectedValue, newValue);
    }

    public final boolean weakCompareAndSetPlain(int i, E expectedValue, E newValue) {
        return compareAndSet(i, expectedValue, newValue);
    }

    public final E getAndUpdate(int i, UnaryOperator<E> updateFunction) {
        E prev = get(i);
        E next = null;
        for (boolean haveNext = false;;) {
            if (!haveNext) {
                next = updateFunction.apply(prev);
            }
            if (compareAndSet(i, prev, next)) {
                return prev;
            }
            haveNext = (prev == (prev = get(i)));
        }
    }

    public final E updateAndGet(int i, UnaryOperator<E> updateFunction) {
        E prev = get(i);
        E next = null;
        for (boolean haveNext = false;;) {
            if (!haveNext) {
                next = updateFunction.apply(prev);
            }
            if (compareAndSet(i, prev, next)) {
                return next;
            }
            haveNext = (prev == (prev = get(i)));
        }
    }

    public final E getAndAccumulate(int i, E x, BinaryOperator<E> accumulatorFunction) {
        E prev = get(i);
        E next = null;
        for (boolean haveNext = false;;) {
            if (!haveNext) {
                next = accumulatorFunction.apply(prev, x);
            }
            if (compareAndSet(i, prev, next)) {
                return prev;
            }
            haveNext = (prev == (prev = get(i)));
        }
    }

    public final E accumulateAndGet(int i, E x, BinaryOperator<E> accumulatorFunction) {
        E prev = get(i);
        E next = null;
        for (boolean haveNext = false;;) {
            if (!haveNext) {
                next = accumulatorFunction.apply(prev, x);
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

    public final E getPlain(int i) {
        return get(i);
    }

    public final void setPlain(int i, E newValue) {
        array[i] = newValue;
    }

    public final E getOpaque(int i) {
        return get(i);
    }

    public final void setOpaque(int i, E newValue) {
        array[i] = newValue;
    }

    public final E getAcquire(int i) {
        return get(i);
    }

    public final void setRelease(int i, E newValue) {
        array[i] = newValue;
    }

    @SuppressWarnings("unchecked")
    public final E compareAndExchange(int i, E expectedValue, E newValue) {
        synchronized (array) {
            Object current = array[i];
            if (current == expectedValue) {
                array[i] = newValue;
            }
            return (E) current;
        }
    }

    public final E compareAndExchangeAcquire(int i, E expectedValue, E newValue) {
        return compareAndExchange(i, expectedValue, newValue);
    }

    public final E compareAndExchangeRelease(int i, E expectedValue, E newValue) {
        return compareAndExchange(i, expectedValue, newValue);
    }

    public final boolean weakCompareAndSetVolatile(int i, E expectedValue, E newValue) {
        return compareAndSet(i, expectedValue, newValue);
    }

    public final boolean weakCompareAndSetAcquire(int i, E expectedValue, E newValue) {
        return compareAndSet(i, expectedValue, newValue);
    }

    public final boolean weakCompareAndSetRelease(int i, E expectedValue, E newValue) {
        return compareAndSet(i, expectedValue, newValue);
    }
}
