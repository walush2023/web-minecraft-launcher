package webmc.jdk;

import java.time.Duration;
import java.util.AbstractList;
import java.util.AbstractMap;
import java.util.Collection;
import java.util.Collections;
import java.util.Deque;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.NavigableMap;
import java.util.NoSuchElementException;
import java.util.RandomAccess;
import java.util.Set;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.atomic.AtomicReferenceArray;

/**
 * Java 17 equivalents of the Java 18 - 21 library methods that Minecraft 1.20.5+ calls (and of
 * older methods CheerpJ cannot run).
 * {@code webmc.ClassDowngrader} redirects those calls here; instance methods become static
 * methods that take the receiver as their first argument.
 */
public final class J21 {
    private J21() {
    }

    // ---- java.util.List / SequencedCollection (21) -----------------------------------
    public static Object getFirst(List<?> list) {
        if (list instanceof Deque) {
            return ((Deque<?>) list).getFirst();
        }
        if (list.isEmpty()) {
            throw new NoSuchElementException();
        }
        return list.get(0);
    }

    public static Object getLast(List<?> list) {
        if (list instanceof Deque) {
            return ((Deque<?>) list).getLast();
        }
        if (list.isEmpty()) {
            throw new NoSuchElementException();
        }
        return list.get(list.size() - 1);
    }

    public static Object removeFirst(List<?> list) {
        if (list instanceof Deque) {
            return ((Deque<?>) list).removeFirst();
        }
        if (list.isEmpty()) {
            throw new NoSuchElementException();
        }
        return list.remove(0);
    }

    public static Object removeLast(List<?> list) {
        if (list instanceof Deque) {
            return ((Deque<?>) list).removeLast();
        }
        if (list.isEmpty()) {
            throw new NoSuchElementException();
        }
        return list.remove(list.size() - 1);
    }

    @SuppressWarnings({"unchecked", "rawtypes"})
    public static void addFirst(List list, Object element) {
        if (list instanceof Deque) {
            ((Deque) list).addFirst(element);
        } else {
            list.add(0, element);
        }
    }

    @SuppressWarnings({"unchecked", "rawtypes"})
    public static void addLast(List list, Object element) {
        if (list instanceof Deque) {
            ((Deque) list).addLast(element);
        } else {
            list.add(element);
        }
    }

    /** A live reverse-ordered view, like Java 21's List.reversed(). */
    public static <E> List<E> reversed(List<E> list) {
        if (list instanceof Reversed) {
            return ((Reversed<E>) list).list;
        }
        return new Reversed<E>(list);
    }

    private static final class Reversed<E> extends AbstractList<E> implements RandomAccess {
        final List<E> list;

        Reversed(List<E> list) {
            this.list = list;
        }

        @Override
        public E get(int index) {
            return list.get(list.size() - 1 - index);
        }

        @Override
        public E set(int index, E element) {
            return list.set(list.size() - 1 - index, element);
        }

        @Override
        public void add(int index, E element) {
            list.add(list.size() - index, element);
        }

        @Override
        public E remove(int index) {
            return list.remove(list.size() - 1 - index);
        }

        @Override
        public int size() {
            return list.size();
        }
    }

    // ---- java.util.Collection as SequencedCollection (21) ------------------------------
    // Also the targets for calls a Java 21 compiler names on another class that only inherits
    // these methods, e.g. Guava's ImmutableList.getFirst() (see ClassDowngrader.SEQUENCED).
    public static Object getFirst(Collection<?> collection) {
        if (collection instanceof List) {
            return getFirst((List<?>) collection);
        }
        if (collection instanceof Deque) {
            return ((Deque<?>) collection).getFirst();
        }
        Iterator<?> it = collection.iterator();
        if (!it.hasNext()) {
            throw new NoSuchElementException();
        }
        return it.next();
    }

    public static Object getLast(Collection<?> collection) {
        if (collection instanceof List) {
            return getLast((List<?>) collection);
        }
        if (collection instanceof Deque) {
            return ((Deque<?>) collection).getLast();
        }
        Iterator<?> it = collection.iterator();
        if (!it.hasNext()) {
            throw new NoSuchElementException();
        }
        Object last = it.next();
        while (it.hasNext()) {
            last = it.next();
        }
        return last;
    }

    public static Object removeFirst(Collection<?> collection) {
        if (collection instanceof List) {
            return removeFirst((List<?>) collection);
        }
        if (collection instanceof Deque) {
            return ((Deque<?>) collection).removeFirst();
        }
        Iterator<?> it = collection.iterator();
        if (!it.hasNext()) {
            throw new NoSuchElementException();
        }
        Object first = it.next();
        it.remove();
        return first;
    }

    public static Object removeLast(Collection<?> collection) {
        if (collection instanceof List) {
            return removeLast((List<?>) collection);
        }
        if (collection instanceof Deque) {
            return ((Deque<?>) collection).removeLast();
        }
        Object last = getLast(collection);
        Iterator<?> it = collection.iterator();
        while (it.hasNext()) {
            if (it.next() == last && !it.hasNext()) {
                it.remove();
            }
        }
        return last;
    }

    @SuppressWarnings({"unchecked", "rawtypes"})
    public static void addFirst(Collection collection, Object element) {
        if (collection instanceof List) {
            addFirst((List) collection, element);
        } else if (collection instanceof Deque) {
            ((Deque) collection).addFirst(element);
        } else {
            throw new UnsupportedOperationException();
        }
    }

    @SuppressWarnings({"unchecked", "rawtypes"})
    public static void addLast(Collection collection, Object element) {
        if (collection instanceof List) {
            addLast((List) collection, element);
        } else if (collection instanceof Deque) {
            ((Deque) collection).addLast(element);
        } else {
            throw new UnsupportedOperationException();
        }
    }

    // ---- java.util.Map as SequencedMap (21) ------------------------------------------
    @SuppressWarnings({"unchecked", "rawtypes"})
    public static Map.Entry pollFirstEntry(Map map) {
        if (map instanceof NavigableMap) {
            return ((NavigableMap) map).pollFirstEntry();
        }
        Iterator<Map.Entry> it = map.entrySet().iterator();
        if (!it.hasNext()) {
            return null;
        }
        Map.Entry entry = it.next();
        Map.Entry copy = new AbstractMap.SimpleImmutableEntry(entry.getKey(), entry.getValue());
        it.remove();
        return copy;
    }

    @SuppressWarnings({"unchecked", "rawtypes"})
    public static Map.Entry firstEntry(Map map) {
        if (map instanceof NavigableMap) {
            return ((NavigableMap) map).firstEntry();
        }
        Iterator<Map.Entry> it = map.entrySet().iterator();
        if (!it.hasNext()) {
            return null;
        }
        Map.Entry entry = it.next();
        return new AbstractMap.SimpleImmutableEntry(entry.getKey(), entry.getValue());
    }

    // ---- AtomicReference(Array).compareAndExchange (9) ---------------------------------
    // CheerpJ has no Unsafe.compareAndExchangeReference native; compareAndSet works.
    @SuppressWarnings({"unchecked", "rawtypes"})
    public static Object compareAndExchange(AtomicReference reference, Object expected, Object value) {
        while (true) {
            Object current = reference.get();
            if (current != expected) {
                return current;
            }
            if (reference.compareAndSet(expected, value)) {
                return expected;
            }
        }
    }

    @SuppressWarnings({"unchecked", "rawtypes"})
    public static Object compareAndExchange(AtomicReferenceArray array, int index, Object expected, Object value) {
        while (true) {
            Object current = array.get(index);
            if (current != expected) {
                return current;
            }
            if (array.compareAndSet(index, expected, value)) {
                return expected;
            }
        }
    }

    // ---- java.util.Collections (21) ----------------------------------------------------
    public static <E> Set<E> unmodifiableSequencedSet(Set<E> set) {
        return Collections.unmodifiableSet(set);
    }

    public static <E> Collection<E> unmodifiableSequencedCollection(Collection<E> collection) {
        return Collections.unmodifiableCollection(collection);
    }

    public static <K, V> Map<K, V> unmodifiableSequencedMap(Map<K, V> map) {
        return Collections.unmodifiableMap(map);
    }

    // ---- java.lang.Math (21) -----------------------------------------------------------
    public static int clamp(long value, int min, int max) {
        if (min > max) {
            throw new IllegalArgumentException(min + " > " + max);
        }
        return (int) Math.min(max, Math.max(value, min));
    }

    public static long clamp(long value, long min, long max) {
        if (min > max) {
            throw new IllegalArgumentException(min + " > " + max);
        }
        return Math.min(max, Math.max(value, min));
    }

    public static float clamp(float value, float min, float max) {
        if (!(min <= max)) {
            throw new IllegalArgumentException(min + " > " + max);
        }
        return Math.min(max, Math.max(value, min));
    }

    public static double clamp(double value, double min, double max) {
        if (!(min <= max)) {
            throw new IllegalArgumentException(min + " > " + max);
        }
        return Math.min(max, Math.max(value, min));
    }

    // ---- java.lang.Thread (19) ---------------------------------------------------------
    @SuppressWarnings("deprecation")
    public static long threadId(Thread thread) {
        return thread.getId();
    }

    public static void sleep(Duration duration) throws InterruptedException {
        long nanos = duration.toNanos();
        if (nanos > 0) {
            Thread.sleep(nanos / 1_000_000L, (int) (nanos % 1_000_000L));
        }
    }
}
