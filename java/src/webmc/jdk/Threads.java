package webmc.jdk;

/** Stand-ins for the game's thread checks (see webmc.GamePatches). */
public final class Threads {
    private Threads() {
    }

    /**
     * 26.x ThreadingDetector.checkAndLock/checkAndUnlock(detector): nothing. They only detect
     * two threads using one PalettedContainer at once (they never wait), each with a lock and a
     * semaphore, for every block read or written: costly in the browser, where world generation
     * spends much of its time in block access.
     */
    public static void unchecked(Object detector) {
    }
}
