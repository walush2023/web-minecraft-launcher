package webmc;

import java.security.Permission;

/**
 * Programs cannot run in the browser, but CheerpJ's process support does not always fail: the
 * second time oshi runs lspci for a system report (1.17+ crash reports collect hardware details)
 * it never returns, and the game hangs instead of reporting its crash. This security manager
 * refuses to start processes, which oshi and the game already handle; everything else is
 * allowed.
 */
final class NoProcesses extends SecurityManager {
    private NoProcesses() {
    }

    static void install() {
        try {
            System.setSecurityManager(new NoProcesses());
        } catch (RuntimeException e) {
            System.err.println("[webmc] could not refuse starting processes: " + e);
        }
    }

    @Override
    public void checkExec(String cmd) {
        throw new SecurityException("webmc: programs cannot run in the browser (" + cmd + ")");
    }

    @Override
    public void checkPermission(Permission perm) {
    }

    @Override
    public void checkPermission(Permission perm, Object context) {
    }
}
