package webmc.jdk;

import java.util.concurrent.Executor;

/**
 * An executor that drops its tasks. 1.13 - 1.16 build their DataFixer with the bootstrap
 * executor, which then spends minutes of browser time warming up every fixer rule; with this
 * executor the rules are built when first needed instead (webmc.GamePatches; the same as the
 * LazyDFU mod does).
 */
public final class NoOpExecutor implements Executor {
    private static final NoOpExecutor INSTANCE = new NoOpExecutor();

    private NoOpExecutor() {
    }

    public static Executor get() {
        return INSTANCE;
    }

    @Override
    public void execute(Runnable task) {
    }
}
