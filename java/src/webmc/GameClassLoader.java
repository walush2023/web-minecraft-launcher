package webmc;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.net.JarURLConnection;
import java.net.MalformedURLException;
import java.net.URL;
import java.net.URLClassLoader;
import java.net.URLConnection;
import java.security.CodeSigner;
import java.security.CodeSource;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.jar.JarEntry;
import java.util.jar.JarFile;
import java.util.jar.Manifest;
import java.util.zip.ZipFile;

/**
 * Loads the game (1.13+) and its libraries, adjusting classes in memory as they are defined:
 * <ul>
 *   <li>Java 18 - 21 classes are downgraded for the browser's Java 17 runtime
 *       ({@link ClassDowngrader});</li>
 *   <li>JDK concurrency classes built on VarHandles (slow in CheerpJ) are replaced by stand-ins
 *       ({@link StandIns});</li>
 *   <li>records get plain-bytecode hashCode/equals/toString ({@link RecordMethods}; CheerpJ's
 *       ObjectMethods bootstrap fails for records with array components);</li>
 *   <li>string concatenations and pattern-matching switches become plain bytecode instead of
 *       method-handle chains ({@link Invokedynamics}), and lambdas become classes this loader
 *       makes itself ({@link Lambdas});</li>
 *   <li>Java Flight Recorder is reported as absent, so the game picks its no-op profiler
 *       (CheerpJ ships the jdk.jfr module, but recording is not supported);</li>
 *   <li>so are VarHandles, to libraries that look them up by name (Guava's futures and hashing,
 *       Netty), which then use Unsafe or plain code instead: CheerpJ runs VarHandles slowly;</li>
 *   <li>classes that catch NullPointerException from field reads get {@link NpePatcher}'s fix;</li>
 *   <li>{@link GamePatches}: a 5x5-chunk spawn area for 1.14 - 1.20.4, as 1.20.5+ uses;</li>
 *   <li>{@link TimeSlices}: game threads yield regularly, so the render thread keeps running
 *       (CheerpJ switches threads only when one blocks);</li>
 *   <li>{@link DebugInfo}: local variable and line number tables are dropped (webmc.debugInfo),
 *       which keeps the browser JVM's class heap from filling up.</li>
 * </ul>
 * The jar files themselves are never modified.
 */
final class GameClassLoader extends URLClassLoader {
    static {
        ClassLoader.registerAsParallelCapable();
    }

    private final Set<String> npePatch;
    private final boolean downgrade;
    private final boolean timeSlices = !"false".equals(System.getProperty("webmc.timeSlices"));
    /** keep, lines (drop local variable tables) or none (line numbers too): see {@link DebugInfo}. */
    private final String debugInfo = System.getProperty("webmc.debugInfo", "keep");
    /** Troubleshooting (?classtrace=1 on the play page): prints every class this loader defines. */
    private final boolean traceClasses = Boolean.getBoolean("webmc.traceClasses");
    private final Map<String, Manifest> manifests = new HashMap<String, Manifest>();
    /** Lambda classes to make on demand, by binary name (see {@link Lambdas}). */
    private final Map<String, Lambdas.Spec> lambdas = new java.util.concurrent.ConcurrentHashMap<String, Lambdas.Spec>();
    /**
     * The class path's jars, opened without signature checks to read classes: the client jar is
     * signed, and the JDK digests every entry read from a signed jar (SHA-512, through the byte
     * array VarHandles CheerpJ runs slowly): that was 40% of the time to the title screen. The
     * JarFiles share their central directories with the URLClassLoader's own.
     */
    private final JarFile[] jars;
    private final URL[] jarUrls;

    private GameClassLoader(URL[] urls, ClassLoader parent, Set<String> npePatch, boolean downgrade) {
        super(urls, parent);
        this.npePatch = npePatch;
        this.downgrade = downgrade;
        this.jarUrls = urls.clone();
        this.jars = new JarFile[urls.length];
    }

    /** @param classpath ':'-separated jar paths; @param npePatch ','-separated internal class names */
    static GameClassLoader create(String classpath, String npePatch, boolean downgrade) throws MalformedURLException {
        String[] paths = classpath.split(":");
        URL[] urls = new URL[paths.length];
        for (int i = 0; i < paths.length; i++) {
            urls[i] = new URL("file", "", paths[i]);
        }
        Set<String> patched = new HashSet<String>();
        for (String name : npePatch.split(",")) {
            if (!name.trim().isEmpty()) {
                patched.add(name.trim());
            }
        }
        return new GameClassLoader(urls, ClassLoader.getSystemClassLoader(), patched, downgrade);
    }

    @Override
    protected Class<?> findClass(String name) throws ClassNotFoundException {
        Lambdas.Spec lambda = lambdas.remove(name);
        if (lambda != null) {
            byte[] bytes;
            try {
                bytes = Lambdas.generate(lambda);
            } catch (IOException e) {
                throw new ClassNotFoundException(name, e);
            }
            if (bytes == null) {
                throw new ClassNotFoundException(name + ": unsupported lambda adaptation");
            }
            return defineClass(name, bytes, 0, bytes.length);
        }
        String path = name.replace('.', '/') + ".class";
        URL[] from = new URL[1];
        byte[] bytes;
        try {
            bytes = readClassFile(path, from);
        } catch (IOException e) {
            throw new ClassNotFoundException(name, e);
        }
        if (bytes == null) {
            throw new ClassNotFoundException(name);
        }
        bytes = transform(name.replace('.', '/'), bytes);
        if (traceClasses) {
            System.out.println("[webmc] class " + name);
        }
        URL jar = from[0];
        definePackageFor(name, jar);
        return defineClass(name, bytes, 0, bytes.length, new CodeSource(jar, (CodeSigner[]) null));
    }

    /** A class file on this loader's class path, as stored (null when there is none). */
    private byte[] classBytes(String internalName) throws IOException {
        return readClassFile(internalName + ".class", new URL[1]);
    }

    /**
     * Reads a class file from the first jar on the class path that has it, without signature
     * checks (see {@link #jars}); {@code from[0]} gets that jar's URL. Null when none has it.
     */
    private byte[] readClassFile(String path, URL[] from) throws IOException {
        for (int i = 0; i < jars.length; i++) {
            JarFile jar = jar(i);
            JarEntry entry = jar == null ? null : jar.getJarEntry(path);
            if (entry != null) {
                from[0] = jarUrls[i];
                try {
                    return read(jar.getInputStream(entry), path);
                } catch (ClassNotFoundException e) {
                    throw new IOException(e);
                }
            }
        }
        return null;
    }

    private JarFile jar(int i) {
        synchronized (jars) {
            if (jars[i] == null) {
                try {
                    jars[i] = openUnverified(new File(jarUrls[i].getPath()));
                } catch (IOException e) {
                    System.err.println("[webmc] cannot open " + jarUrls[i] + ": " + e);
                    return null;
                }
            }
            return jars[i];
        }
    }

    /**
     * A jar opened without verification, with multi-release entries resolved for the running
     * JVM as URLClassLoader does. The constructor for that is Java 9 API (this class is built for
     * Java 8; the game loader only runs on CheerpJ's Java 17).
     */
    private static JarFile openUnverified(File file) throws IOException {
        try {
            Class<?> version = Class.forName("java.lang.Runtime$Version");
            Object runtime = Runtime.class.getMethod("version").invoke(null);
            return (JarFile) JarFile.class.getConstructor(File.class, boolean.class, int.class, version)
                .newInstance(file, false, ZipFile.OPEN_READ, runtime);
        } catch (java.lang.reflect.InvocationTargetException e) {
            if (e.getCause() instanceof IOException) {
                throw (IOException) e.getCause();
            }
            throw new IOException(e.getCause());
        } catch (ReflectiveOperationException e) {
            return new JarFile(file, false);
        }
    }

    private byte[] transform(String internalName, byte[] bytes) {
        try {
            if (downgrade) {
                bytes = ClassDowngrader.downgrade(bytes, this::classBytes);
            }
            bytes = StandIns.apply(bytes);
            bytes = RecordMethods.inline(bytes);
            bytes = Invokedynamics.lower(bytes);
            bytes = Lambdas.lower(internalName, bytes, lambdas);
            bytes = ClassDowngrader.replaceString(bytes, "jdk.jfr", "webmc.jfr-unavailable");
            bytes = ClassDowngrader.replaceString(bytes, "java.lang.invoke.VarHandle", "webmc.VarHandle-unavailable");
            bytes = GamePatches.apply(internalName, bytes);
            if (timeSlices && TimeSlices.isGameClass(internalName)) {
                bytes = TimeSlices.instrument(bytes);
            }
            if (npePatch.contains(internalName)) {
                byte[] patched = NpePatcher.patchClass(bytes);
                if (patched != null) {
                    System.out.println("[webmc] patched NullPointerException handling in " + internalName);
                    bytes = patched;
                }
            }
            if (!"keep".equals(debugInfo)) {
                bytes = DebugInfo.strip(bytes, "lines".equals(debugInfo));
            }
        } catch (Exception e) {
            System.err.println("[webmc] could not adjust " + internalName + ": " + e);
        }
        return bytes;
    }

    private void definePackageFor(String className, URL jar) {
        int dot = className.lastIndexOf('.');
        if (dot < 0) {
            return;
        }
        String pkg = className.substring(0, dot);
        if (getPackage(pkg) != null) {
            return;
        }
        try {
            Manifest manifest = manifest(jar);
            if (manifest != null) {
                definePackage(pkg, manifest, jar);
            } else {
                definePackage(pkg, null, null, null, null, null, null, null);
            }
        } catch (IllegalArgumentException alreadyDefined) {
            // another thread defined it first
        }
    }

    private Manifest manifest(URL jar) {
        synchronized (manifests) {
            String key = jar.toString();
            if (manifests.containsKey(key)) {
                return manifests.get(key);
            }
            Manifest manifest = null;
            try {
                URLConnection connection = new URL("jar:" + key + "!/").openConnection();
                manifest = ((JarURLConnection) connection).getManifest();
            } catch (IOException e) {
                // no manifest
            }
            manifests.put(key, manifest);
            return manifest;
        }
    }

    private static byte[] read(InputStream in, String name) throws ClassNotFoundException {
        if (in == null) {
            throw new ClassNotFoundException(name);
        }
        try {
            try {
                ByteArrayOutputStream out = new ByteArrayOutputStream(8192);
                byte[] buffer = new byte[8192];
                int n;
                while ((n = in.read(buffer)) > 0) {
                    out.write(buffer, 0, n);
                }
                return out.toByteArray();
            } finally {
                in.close();
            }
        } catch (IOException e) {
            throw new ClassNotFoundException(name, e);
        }
    }
}
