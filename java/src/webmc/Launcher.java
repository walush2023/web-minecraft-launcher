package webmc;

import java.applet.Applet;
import java.applet.AppletContext;
import java.applet.AppletStub;
import java.awt.BorderLayout;
import java.awt.Canvas;
import java.awt.Color;
import java.awt.Dimension;
import java.awt.Frame;
import java.awt.Graphics;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import javax.imageio.ImageIO;
import java.awt.event.WindowAdapter;
import java.awt.event.WindowEvent;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.net.MalformedURLException;
import java.net.URL;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;

/**
 * Entry point used by the web launcher in front of the real Minecraft main class.
 *
 * <p>Usage: {@code webmc.Launcher <main class> [game arguments...]}
 *
 * <p>With {@code -Dwebmc.applet=<applet class>} (clients before 1.6) the game is hosted as an
 * applet inside an undecorated frame that exactly covers the browser display
 * ({@code -Dwebmc.width}/{@code -Dwebmc.height}), the way Mojang's original launcher ran it.
 * The client's own {@code main()} would open a decorated 854x480 window instead. The game
 * arguments are then {@code <username> <session>}. Otherwise the main class is invoked as is.
 */
public final class Launcher {
    private Launcher() {
    }

    public static void main(String[] args) throws Throwable {
        if (args.length == 0) {
            System.err.println("[webmc] usage: webmc.Launcher <main class> [args...]");
            System.exit(2);
        }
        String mainClass = args[0];
        String[] gameArgs = Arrays.copyOfRange(args, 1, args.length);

        boolean lwjgl3 = Boolean.getBoolean("webmc.lwjgl3");
        if (lwjgl3) {
            // 1.13+: LWJGL 3 runs on the JavaScript natives in public/lwjgl3 (no AWT, no X11).
            Class.forName("webmc.lwjgl.Bridge").getMethod("setup").invoke(null);
            NoProcesses.install();
        }

        if (Boolean.getBoolean("webmc.keyBridge")) {
            KeyBridge.start();
        }

        int dumpSeconds = Integer.getInteger("webmc.threadDump", 0);
        if (dumpSeconds > 0) {
            startThreadDumps(dumpSeconds);
        }

        if (!lwjgl3) {
            preloadClasses();
        }

        // 1.13+: the game is loaded by GameClassLoader, which adjusts classes in memory.
        String npePatch = System.getProperty("webmc.npePatch", "");
        String gameClasspath = System.getProperty("webmc.gameClasspath", "");
        ClassLoader loader = ClassLoader.getSystemClassLoader();
        if (!gameClasspath.isEmpty()) {
            loader = GameClassLoader.create(gameClasspath, npePatch, Boolean.getBoolean("webmc.downgrade"));
            Thread.currentThread().setContextClassLoader(loader);
            // The game's main thread becomes its render thread; it is the one never asked to yield.
            webmc.jdk.Sched.setRenderThread(Thread.currentThread());
            if (Boolean.getBoolean("webmc.gameState")) {
                webmc.jdk.GameState.start(loader);
            }
        } else if (!npePatch.isEmpty()) {
            NpePatcher.patchAll(npePatch, mainClass);
        }

        String appletClass = System.getProperty("webmc.applet", "");
        if (!appletClass.isEmpty()) {
            startApplet(appletClass, gameArgs);
            return;
        }

        if (Boolean.getBoolean("webmc.parentDisplay")) {
            parentDisplay();
        }

        Method main = Class.forName(mainClass, true, loader).getMethod("main", String[].class);
        try {
            main.invoke(null, (Object) gameArgs);
        } catch (InvocationTargetException e) {
            throw e.getCause();
        }
    }

    private static void startApplet(String appletClass, String[] gameArgs) throws Exception {
        int width = Integer.getInteger("webmc.width", 854);
        int height = Integer.getInteger("webmc.height", 480);

        Map<String, String> parameters = new HashMap<String, String>();
        parameters.put("username", gameArgs.length > 0 ? gameArgs[0] : "Player");
        parameters.put("sessionid", gameArgs.length > 1 ? gameArgs[1] : "-");
        parameters.put("stand-alone", "true");
        parameters.put("haspaid", "true");
        parameters.put("demo", "false");
        parameters.put("fullscreen", "false");

        final Applet applet = (Applet) findAppletClass(appletClass).getDeclaredConstructor().newInstance();
        applet.setStub(new Stub(parameters));
        applet.setSize(width, height);
        applet.setPreferredSize(new Dimension(width, height));

        Frame frame = new Frame("Minecraft");
        frame.setUndecorated(true);
        frame.setBackground(Color.BLACK);
        frame.setLayout(new BorderLayout());
        frame.add(applet, BorderLayout.CENTER);
        frame.setBounds(0, 0, width, height);
        frame.addWindowListener(new WindowAdapter() {
            @Override
            public void windowClosing(WindowEvent event) {
                applet.stop();
                applet.destroy();
                System.exit(0);
            }
        });
        frame.setVisible(true);
        applet.init();
        applet.start();
        frame.validate();

        startExitWatcher();
    }

    /**
     * In a running game CheerpJ has been seen failing to load JDK imaging classes on first use
     * (NoClassDefFoundError for DataBufferInt, BufImgSurfaceManager), crashing 1.9+ when it saves
     * a world icon or a screenshot. Running the same operations once at startup loads them early.
     */
    private static void preloadClasses() {
        try {
            BufferedImage source = new BufferedImage(4, 4, BufferedImage.TYPE_INT_RGB);
            source.setRGB(0, 0, 4, 4, new int[16], 0, 4);
            BufferedImage target = new BufferedImage(2, 2, BufferedImage.TYPE_INT_RGB);
            Graphics graphics = target.createGraphics();
            graphics.drawImage(source, 0, 0, 2, 2, 0, 0, 4, 4, null);
            graphics.dispose();
            ImageIO.write(target, "png", new ByteArrayOutputStream());
            new BufferedImage(2, 2, BufferedImage.TYPE_INT_ARGB).getRGB(0, 0);
        } catch (Throwable t) {
            System.err.println("[webmc] imaging warm-up failed: " + t);
        }
    }

    /**
     * CheerpJ only shows X11 windows that belong to an AWT component, so an LWJGL display
     * created on its own (1.6+) would render into nothing. Host it in an undecorated frame
     * covering the browser display instead; the game later creates its display inside it.
     */
    private static void parentDisplay() throws Exception {
        int width = Integer.getInteger("webmc.width", 854);
        int height = Integer.getInteger("webmc.height", 480);
        final Frame frame = new Frame("Minecraft");
        frame.setUndecorated(true);
        frame.setBackground(Color.BLACK);
        frame.setLayout(new BorderLayout());
        Canvas canvas = new Canvas();
        canvas.setBackground(Color.BLACK);
        canvas.setPreferredSize(new Dimension(width, height));
        // If the canvas owned AWT focus, LWJGL would call XSetInputFocus, which CheerpJ's
        // X11 server does not implement (it aborts). Input reaches the game window anyway.
        canvas.setFocusable(false);
        frame.add(canvas, BorderLayout.CENTER);
        frame.setBounds(0, 0, width, height);
        frame.addWindowListener(new WindowAdapter() {
            @Override
            public void windowClosing(WindowEvent event) {
                System.exit(0);
            }
        });
        frame.setVisible(true);
        frame.validate();
        Class.forName("org.lwjgl.opengl.Display").getMethod("setParent", Canvas.class).invoke(null, canvas);
    }

    /** Troubleshooting (?threaddump=N on the play page): prints every thread's stack every N seconds. */
    private static void startThreadDumps(final int seconds) {
        Thread dumper = new Thread(new Runnable() {
            @Override
            public void run() {
                while (true) {
                    try {
                        Thread.sleep(seconds * 1000L);
                    } catch (InterruptedException e) {
                        return;
                    }
                    // Thread.getAllStackTraces() is empty in CheerpJ; enumerate the root group instead.
                    ThreadGroup root = Thread.currentThread().getThreadGroup();
                    while (root.getParent() != null) {
                        root = root.getParent();
                    }
                    Thread[] threads = new Thread[root.activeCount() + 16];
                    int n = root.enumerate(threads, true);
                    StringBuilder out = new StringBuilder("[webmc] thread dump (" + n + " threads)\n");
                    for (int t = 0; t < n; t++) {
                        out.append("[webmc]   \"").append(threads[t].getName()).append("\" ").append(threads[t].getState()).append('\n');
                        StackTraceElement[] stack;
                        try {
                            stack = threads[t].getStackTrace();
                        } catch (Throwable e) {
                            stack = new StackTraceElement[0];
                        }
                        for (int i = 0; i < Math.min(stack.length, 14); i++) {
                            out.append("[webmc]       ").append(stack[i]).append('\n');
                        }
                    }
                    System.out.print(out);
                }
            }
        }, "webmc-thread-dump");
        dumper.setDaemon(true);
        dumper.start();
    }

    /** "auto" picks the applet class the same way launchwrapper's AlphaVanillaTweakInjector does. */
    private static Class<?> findAppletClass(String name) throws ClassNotFoundException {
        if (!"auto".equals(name)) {
            return Class.forName(name);
        }
        try {
            return Class.forName("net.minecraft.client.MinecraftApplet");
        } catch (ClassNotFoundException e) {
            return Class.forName("com.mojang.minecraft.MinecraftApplet");
        }
    }

    /**
     * Applet-hosted clients never call System.exit(): "Quit Game" only stops the game thread
     * and destroys the LWJGL display. Exit once that happens so the page can show its menu.
     */
    private static void startExitWatcher() {
        Thread watcher = new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    Method isCreated = Class.forName("org.lwjgl.opengl.Display").getMethod("isCreated");
                    boolean seen = false;
                    int goneTicks = 0;
                    while (true) {
                        Thread.sleep(1000);
                        boolean created = (Boolean) isCreated.invoke(null);
                        if (created) {
                            seen = true;
                            goneTicks = 0;
                        } else if (seen && ++goneTicks >= 3) {
                            System.exit(0);
                        }
                    }
                } catch (Exception e) {
                    System.err.println("[webmc] exit watcher stopped: " + e);
                }
            }
        }, "webmc-exit-watcher");
        watcher.setDaemon(true);
        watcher.start();
    }

    private static final class Stub implements AppletStub {
        private final Map<String, String> parameters;

        Stub(Map<String, String> parameters) {
            this.parameters = parameters;
        }

        @Override
        public boolean isActive() {
            return true;
        }

        @Override
        public URL getDocumentBase() {
            try {
                return new URL("http://www.minecraft.net/game/");
            } catch (MalformedURLException e) {
                throw new IllegalStateException(e);
            }
        }

        @Override
        public URL getCodeBase() {
            return getDocumentBase();
        }

        @Override
        public String getParameter(String name) {
            return parameters.get(name);
        }

        @Override
        public AppletContext getAppletContext() {
            return null;
        }

        @Override
        public void appletResize(int width, int height) {
        }
    }
}
