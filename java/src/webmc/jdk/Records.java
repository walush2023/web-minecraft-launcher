package webmc.jdk;

import java.util.Objects;

/** Comparisons used by the record methods that webmc.RecordMethods generates. */
public final class Records {
    private Records() {
    }

    /**
     * {@code other} when it is the same record class (as tested by instanceof, records being final),
     * else {@code self}: the generated equals then compares self with itself and returns false.
     */
    public static Object pick(Object other, Object self, boolean sameClass) {
        return sameClass ? other : self;
    }

    public static boolean eq(int a, int b) {
        return a == b;
    }

    public static boolean eq(long a, long b) {
        return a == b;
    }

    public static boolean eq(float a, float b) {
        return Float.compare(a, b) == 0;
    }

    public static boolean eq(double a, double b) {
        return Double.compare(a, b) == 0;
    }

    public static boolean eq(Object a, Object b) {
        return Objects.equals(a, b);
    }
}
