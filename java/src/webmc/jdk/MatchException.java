package webmc.jdk;

/** Stands in for java.lang.MatchException (Java 21), thrown by exhaustive switches. */
public class MatchException extends RuntimeException {
    private static final long serialVersionUID = 1L;

    public MatchException(String message, Throwable cause) {
        super(message, cause);
    }
}
