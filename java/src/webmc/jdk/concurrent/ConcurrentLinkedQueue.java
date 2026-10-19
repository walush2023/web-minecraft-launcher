package webmc.jdk.concurrent;

import java.util.AbstractQueue;
import java.util.ArrayDeque;
import java.util.Collection;
import java.util.Iterator;
import java.util.NoSuchElementException;
import java.util.function.Consumer;
import java.util.function.Predicate;

/**
 * Stand-in for {@code java.util.concurrent.ConcurrentLinkedQueue} in the game's classes (see
 * {@code webmc.StandIns}): Java 17 links its nodes through VarHandles, which CheerpJ makes slow
 * (see {@link AtomicReferenceArray}); the game's task queues go through it for every task. This
 * one is an ArrayDeque behind the queue's monitor. Iterators work on a snapshot, so they never
 * fail while other threads change the queue (as the original's are weakly consistent).
 */
public class ConcurrentLinkedQueue<E> extends AbstractQueue<E> implements java.io.Serializable {
    private static final long serialVersionUID = 196745693267521676L;

    private final ArrayDeque<E> items = new ArrayDeque<E>();

    public ConcurrentLinkedQueue() {
    }

    public ConcurrentLinkedQueue(Collection<? extends E> c) {
        for (E e : c) {
            offer(e);
        }
    }

    @Override
    public boolean add(E e) {
        return offer(e);
    }

    @Override
    public synchronized boolean offer(E e) {
        items.addLast(e); // null -> NullPointerException, as in the original
        return true;
    }

    @Override
    public synchronized E poll() {
        return items.pollFirst();
    }

    @Override
    public synchronized E peek() {
        return items.peekFirst();
    }

    @Override
    public synchronized boolean isEmpty() {
        return items.isEmpty();
    }

    @Override
    public synchronized int size() {
        return items.size();
    }

    @Override
    public synchronized boolean contains(Object o) {
        return o != null && items.contains(o);
    }

    @Override
    public synchronized boolean remove(Object o) {
        return o != null && items.removeFirstOccurrence(o);
    }

    @Override
    public boolean addAll(Collection<? extends E> c) {
        if (c == this) {
            throw new IllegalArgumentException();
        }
        boolean changed = false;
        for (E e : c) {
            changed |= offer(e);
        }
        return changed;
    }

    @Override
    public synchronized void clear() {
        items.clear();
    }

    @Override
    public synchronized Object[] toArray() {
        return items.toArray();
    }

    @Override
    public synchronized <T> T[] toArray(T[] a) {
        return items.toArray(a);
    }

    @Override
    public boolean removeIf(Predicate<? super E> filter) {
        boolean removed = false;
        for (Object o : toArray()) {
            @SuppressWarnings("unchecked")
            E e = (E) o;
            if (filter.test(e)) {
                removed |= removeSame(e);
            }
        }
        return removed;
    }

    @Override
    @SuppressWarnings("unchecked")
    public void forEach(Consumer<? super E> action) {
        for (Object o : toArray()) {
            action.accept((E) o);
        }
    }

    @Override
    public Iterator<E> iterator() {
        return new Snapshot(toArray());
    }

    private synchronized boolean removeSame(Object o) {
        for (Iterator<E> it = items.iterator(); it.hasNext();) {
            if (it.next() == o) {
                it.remove();
                return true;
            }
        }
        return false;
    }

    private final class Snapshot implements Iterator<E> {
        private final Object[] elements;
        private int next;
        private Object last;

        Snapshot(Object[] elements) {
            this.elements = elements;
        }

        @Override
        public boolean hasNext() {
            return next < elements.length;
        }

        @Override
        @SuppressWarnings("unchecked")
        public E next() {
            if (next >= elements.length) {
                throw new NoSuchElementException();
            }
            last = elements[next++];
            return (E) last;
        }

        @Override
        public void remove() {
            if (last == null) {
                throw new IllegalStateException();
            }
            removeSame(last);
            last = null;
        }
    }
}
