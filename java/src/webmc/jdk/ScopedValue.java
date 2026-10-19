package webmc.jdk;

import java.util.NoSuchElementException;
import java.util.function.Supplier;

/**
 * Stands in for java.lang.ScopedValue (Java 25), which Minecraft 26.x uses to pass context down a
 * call (file fixers, block state debugging). A value is bound for the duration of
 * {@link Carrier#run}/{@link Carrier#call} on the current thread; bindings form a per-thread
 * stack, so nested and repeated bindings behave as in the JDK.
 */
public final class ScopedValue<T> {
    private static final ThreadLocal<Binding> BINDINGS = new ThreadLocal<Binding>();

    private static final class Binding {
        final ScopedValue<?> key;
        final Object value;
        final Binding next;

        Binding(ScopedValue<?> key, Object value, Binding next) {
            this.key = key;
            this.value = value;
            this.next = next;
        }
    }

    private ScopedValue() {
    }

    public static <T> ScopedValue<T> newInstance() {
        return new ScopedValue<T>();
    }

    private Binding find() {
        for (Binding b = BINDINGS.get(); b != null; b = b.next) {
            if (b.key == this) {
                return b;
            }
        }
        return null;
    }

    @SuppressWarnings("unchecked")
    public T get() {
        Binding b = find();
        if (b == null) {
            throw new NoSuchElementException("ScopedValue not bound");
        }
        return (T) b.value;
    }

    public boolean isBound() {
        return find() != null;
    }

    @SuppressWarnings("unchecked")
    public T orElse(T other) {
        Binding b = find();
        return b == null ? other : (T) b.value;
    }

    @SuppressWarnings("unchecked")
    public <X extends Throwable> T orElseThrow(Supplier<? extends X> exceptionSupplier) throws X {
        Binding b = find();
        if (b == null) {
            throw exceptionSupplier.get();
        }
        return (T) b.value;
    }

    public static <T> Carrier where(ScopedValue<T> key, T value) {
        return new Carrier(null, key, value);
    }

    /** Bindings to apply for an operation. */
    public static final class Carrier {
        private final Carrier previous;
        private final ScopedValue<?> key;
        private final Object value;

        Carrier(Carrier previous, ScopedValue<?> key, Object value) {
            this.previous = previous;
            this.key = key;
            this.value = value;
        }

        public <T> Carrier where(ScopedValue<T> key, T value) {
            return new Carrier(this, key, value);
        }

        @SuppressWarnings("unchecked")
        public <T> T get(ScopedValue<T> key) {
            for (Carrier c = this; c != null; c = c.previous) {
                if (c.key == key) {
                    return (T) c.value;
                }
            }
            throw new NoSuchElementException("key not bound by this carrier");
        }

        private Binding bind(Binding below) {
            Binding top = below;
            // The first where() is the outermost binding; later ones shadow it.
            java.util.ArrayDeque<Carrier> order = new java.util.ArrayDeque<Carrier>();
            for (Carrier c = this; c != null; c = c.previous) {
                order.push(c);
            }
            for (Carrier c : order) {
                top = new Binding(c.key, c.value, top);
            }
            return top;
        }

        public void run(Runnable op) {
            Binding saved = BINDINGS.get();
            BINDINGS.set(bind(saved));
            try {
                op.run();
            } finally {
                BINDINGS.set(saved);
            }
        }

        public <R, X extends Throwable> R call(CallableOp<? extends R, X> op) throws X {
            Binding saved = BINDINGS.get();
            BINDINGS.set(bind(saved));
            try {
                return op.call();
            } finally {
                BINDINGS.set(saved);
            }
        }
    }

    /** An operation run with bindings that returns a result or throws. */
    public interface CallableOp<T, X extends Throwable> {
        T call() throws X;
    }
}
