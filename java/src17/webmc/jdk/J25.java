package webmc.jdk;

import java.io.IOException;
import java.io.Reader;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.nio.file.Path;
import java.time.Duration;

/**
 * Java 17 equivalents of the Java 18 - 25 library methods that Minecraft 26.1+ calls and that
 * need the Java 11 - 17 API (compiled with --release 17, so this class only loads on the Java
 * 17 runtime). {@code webmc.ClassDowngrader} redirects the calls here; instance methods become
 * static methods that take the receiver as their first argument.
 */
public final class J25 {
    private J25() {
    }

    // ---- java.io.Reader (25) -----------------------------------------------------------
    public static String readAllAsString(Reader reader) throws IOException {
        StringBuilder text = new StringBuilder();
        char[] buffer = new char[8192];
        for (int n; (n = reader.read(buffer)) >= 0; ) {
            text.append(buffer, 0, n);
        }
        return text.toString();
    }

    // ---- java.lang.Math (18, 25) -------------------------------------------------------
    public static int floorDivExact(int x, int y) {
        if (x == Integer.MIN_VALUE && y == -1) {
            throw new ArithmeticException("integer overflow");
        }
        return Math.floorDiv(x, y);
    }

    public static long floorDivExact(long x, long y) {
        if (x == Long.MIN_VALUE && y == -1) {
            throw new ArithmeticException("long overflow");
        }
        return Math.floorDiv(x, y);
    }

    public static int powExact(int x, int n) {
        if (n < 0) {
            throw new ArithmeticException("negative exponent");
        }
        int result = 1;
        for (int i = 0; i < n; i++) {
            result = Math.multiplyExact(result, x);
        }
        return result;
    }

    public static long powExact(long x, int n) {
        if (n < 0) {
            throw new ArithmeticException("negative exponent");
        }
        long result = 1;
        for (int i = 0; i < n; i++) {
            result = Math.multiplyExact(result, x);
        }
        return result;
    }

    // ---- java.net.http (18, 21) --------------------------------------------------------
    /** HttpClient became AutoCloseable in Java 21; before, its resources were simply dropped. */
    public static void close(HttpClient client) {
    }

    public static HttpRequest.Builder HEAD(HttpRequest.Builder builder) {
        return builder.method("HEAD", HttpRequest.BodyPublishers.noBody());
    }

    // ---- java.nio.file.Path (22) -------------------------------------------------------
    public static Path resolve(Path path, String first, String... more) {
        Path result = path.resolve(first);
        for (String name : more) {
            result = result.resolve(name);
        }
        return result;
    }

    // ---- java.time.Duration (18) -------------------------------------------------------
    public static boolean isPositive(Duration duration) {
        return !duration.isNegative() && !duration.isZero();
    }
}
