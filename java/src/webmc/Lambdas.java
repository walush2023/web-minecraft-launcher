package webmc;

import static webmc.ClassFiles.CLASS;
import static webmc.ClassFiles.INTERFACE_METHODREF;
import static webmc.ClassFiles.INVOKEDYNAMIC;
import static webmc.ClassFiles.INVOKEINTERFACE;
import static webmc.ClassFiles.INVOKESPECIAL;
import static webmc.ClassFiles.INVOKESTATIC;
import static webmc.ClassFiles.INVOKEVIRTUAL;
import static webmc.ClassFiles.INVOKE_DYNAMIC;
import static webmc.ClassFiles.METHODREF;
import static webmc.ClassFiles.METHOD_HANDLE;
import static webmc.ClassFiles.NAME_AND_TYPE;
import static webmc.ClassFiles.contains;
import static webmc.ClassFiles.instructionLength;
import static webmc.ClassFiles.skipMembers;
import static webmc.ClassFiles.u2;
import static webmc.ClassFiles.u4;

import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Lambdas and method references as plain classes, made when the class that uses them is loaded
 * (as javac's predecessors, retrolambda and Android's D8 do), instead of through
 * {@code LambdaMetafactory}. In CheerpJ every evaluation of a lambda expression runs the call
 * site's method handle chain, resolving the target by name each time, so creating a capturing
 * lambda costs tens of microseconds; the game creates them in its hottest loops (entity lookups,
 * fluid spreading, collisions).
 *
 * <p>A call site {@code invokedynamic #i} becomes {@code invokestatic Host$webmc$lambda$i.create}
 * (plus two {@code nop}s), and {@link GameClassLoader} defines that class from the recorded
 * {@link Spec} when it is first needed: final fields for the captured values, a constructor, the
 * interface method (and bridges) calling the implementation with javac's adaptations
 * (casts, boxing, unboxing, widening). Lambdas that capture nothing share one instance, as with
 * LambdaMetafactory.
 *
 * <p>The generated classes call the host's private implementation methods directly. That would
 * need nest membership on the JVM; CheerpJ does not check access between classes. Serializable
 * lambdas keep their invokedynamic. Disabled with {@code -Dwebmc.lowerLambdas=false}.
 */
final class Lambdas {
    static final boolean ENABLED = !"false".equals(System.getProperty("webmc.lowerLambdas"));

    private static final String METAFACTORY = "java/lang/invoke/LambdaMetafactory";
    private static final String OBJECT = "java/lang/Object";
    private static final int FLAG_SERIALIZABLE = 1;
    private static final int FLAG_MARKERS = 2;
    private static final int FLAG_BRIDGES = 4;
    private static final int INTEGER = 3;
    private static final int METHOD_TYPE = 16;
    private static final int REF_INVOKE_VIRTUAL = 5;
    private static final int REF_INVOKE_STATIC = 6;
    private static final int REF_INVOKE_SPECIAL = 7;
    private static final int REF_NEW_INVOKE_SPECIAL = 8;
    private static final int REF_INVOKE_INTERFACE = 9;

    /** Everything a lambda class is made from, recorded when its call site is rewritten. */
    static final class Spec {
        final String className;
        final String[] interfaces;
        final String methodName;
        final String[] methodDescriptors;
        final String dynamicDescriptor;
        final List<String> captured;
        final String factoryDescriptor;
        final int implKind;
        final String implOwner;
        final String implName;
        final String implDescriptor;
        final boolean implInterface;

        Spec(String className, String[] interfaces, String methodName, String[] methodDescriptors, String dynamicDescriptor,
                List<String> captured, String factoryDescriptor, int implKind, String implOwner, String implName,
                String implDescriptor, boolean implInterface) {
            this.className = className;
            this.interfaces = interfaces;
            this.methodName = methodName;
            this.methodDescriptors = methodDescriptors;
            this.dynamicDescriptor = dynamicDescriptor;
            this.captured = captured;
            this.factoryDescriptor = factoryDescriptor;
            this.implKind = implKind;
            this.implOwner = implOwner;
            this.implName = implName;
            this.implDescriptor = implDescriptor;
            this.implInterface = implInterface;
        }
    }

    private Lambdas() {
    }

    /**
     * Rewrites the class's lambda call sites and records their classes in {@code specs} (keyed
     * by binary name). Returns the class unchanged when it has none that can be rewritten.
     */
    static byte[] lower(String internalName, byte[] in, Map<String, Spec> specs) throws IOException {
        if (!ENABLED || !contains(in, METAFACTORY)) {
            return in;
        }
        Pool pool = new Pool(in);
        Map<Integer, Boolean> metafactories = new HashMap<Integer, Boolean>(); // handle -> alt
        for (int i = 1; i < pool.originalCount; i++) {
            if (pool.tag(i) != METHOD_HANDLE) {
                continue;
            }
            int ref = pool.u2(i, 2);
            int refTag = pool.tag(ref);
            if ((refTag == METHODREF || refTag == INTERFACE_METHODREF) && METAFACTORY.equals(pool.className(pool.u2(ref, 1)))) {
                String name = pool.memberName(ref);
                if ("metafactory".equals(name) || "altMetafactory".equals(name)) {
                    metafactories.put(i, "altMetafactory".equals(name));
                }
            }
        }
        if (metafactories.isEmpty()) {
            return in;
        }
        byte[] rest = pool.rest();
        int p = 6;
        p += 2 + u2(rest, p) * 2; // interfaces
        p = skipMembers(rest, p); // fields
        int methodsStart = p;
        int methodsEnd = skipMembers(rest, p);
        List<int[]> bootstraps = bootstrapMethods(pool, rest, methodsEnd);
        if (bootstraps == null) {
            return in;
        }
        Map<Integer, Integer> replaced = new HashMap<Integer, Integer>();
        for (int i = 1; i < pool.originalCount; i++) {
            if (pool.tag(i) != INVOKE_DYNAMIC) {
                continue;
            }
            int bootstrapIndex = pool.u2(i, 1);
            if (bootstrapIndex >= bootstraps.size()) {
                continue;
            }
            int[] bootstrap = bootstraps.get(bootstrapIndex);
            Boolean alt = metafactories.get(bootstrap[0]);
            if (alt == null) {
                continue;
            }
            int nat = pool.u2(i, 3);
            String className = internalName + "$webmc$lambda$" + i;
            Spec spec = spec(pool, className, internalName, pool.utf8(pool.u2(nat, 1)), pool.utf8(pool.u2(nat, 3)), bootstrap, alt);
            if (spec == null) {
                continue;
            }
            specs.put(className.replace('/', '.'), spec);
            replaced.put(i, pool.addMethodref(className, "create", spec.factoryDescriptor));
        }
        if (replaced.isEmpty()) {
            return in;
        }
        rewriteCalls(rest, pool, methodsStart, replaced);
        ByteArrayOutputStream out = new ByteArrayOutputStream(in.length + 256);
        DataOutputStream data = new DataOutputStream(out);
        data.write(in, 0, 8);
        pool.write(data);
        data.write(rest);
        data.flush();
        return out.toByteArray();
    }

    /** The lambda's description, or null when this call site is left to LambdaMetafactory. */
    private static Spec spec(Pool pool, String className, String host, String methodName, String factoryDescriptor, int[] bootstrap,
            boolean alt) {
        if (bootstrap.length < 4 || pool.tag(bootstrap[1]) != METHOD_TYPE || pool.tag(bootstrap[2]) != METHOD_HANDLE
                || pool.tag(bootstrap[3]) != METHOD_TYPE) {
            return null;
        }
        String samDescriptor = pool.utf8(pool.u2(bootstrap[1], 1));
        String dynamicDescriptor = pool.utf8(pool.u2(bootstrap[3], 1));
        int implKind = pool.entries.get(bootstrap[2])[1];
        int implRef = pool.u2(bootstrap[2], 2);
        String implOwner = pool.className(pool.u2(implRef, 1));
        String implName = pool.memberName(implRef);
        String implDescriptor = pool.memberDescriptor(implRef);
        boolean implInterface = pool.tag(implRef) == INTERFACE_METHODREF;
        if (implOwner.startsWith("java/lang/invoke/") || implKind < REF_INVOKE_VIRTUAL || implKind > REF_INVOKE_INTERFACE
                || (implKind == REF_INVOKE_SPECIAL && !implOwner.equals(host))) {
            return null;
        }
        List<String> interfaces = new ArrayList<String>();
        List<String> descriptors = new ArrayList<String>();
        String returnType = returnType(factoryDescriptor);
        if (returnType == null || !returnType.startsWith("L")) {
            return null;
        }
        interfaces.add(returnType.substring(1, returnType.length() - 1));
        descriptors.add(samDescriptor);
        if (alt) {
            int k = 4;
            if (k >= bootstrap.length || pool.tag(bootstrap[k]) != INTEGER) {
                return null;
            }
            int flags = intConstant(pool, bootstrap[k++]);
            if ((flags & FLAG_SERIALIZABLE) != 0) {
                return null;
            }
            if ((flags & FLAG_MARKERS) != 0) {
                int count = k < bootstrap.length ? intConstant(pool, bootstrap[k++]) : -1;
                for (int m = 0; m < count; m++) {
                    if (k >= bootstrap.length || pool.tag(bootstrap[k]) != CLASS) {
                        return null;
                    }
                    String marker = pool.className(bootstrap[k++]);
                    if (!interfaces.contains(marker)) {
                        interfaces.add(marker);
                    }
                }
            }
            if ((flags & FLAG_BRIDGES) != 0) {
                int count = k < bootstrap.length ? intConstant(pool, bootstrap[k++]) : -1;
                for (int m = 0; m < count; m++) {
                    if (k >= bootstrap.length || pool.tag(bootstrap[k]) != METHOD_TYPE) {
                        return null;
                    }
                    String bridge = pool.utf8(pool.u2(bootstrap[k++], 1));
                    if (!descriptors.contains(bridge)) {
                        descriptors.add(bridge);
                    }
                }
            }
        }
        List<String> captured = Invokedynamics.parameterTypes(factoryDescriptor);
        List<String> implParams = Invokedynamics.parameterTypes(implDescriptor);
        if (captured == null || implParams == null || Invokedynamics.parameterTypes(dynamicDescriptor) == null) {
            return null;
        }
        // Every interface method takes the implementation's arguments that were not captured.
        int expected = implParams.size() + (implKind == REF_INVOKE_STATIC || implKind == REF_NEW_INVOKE_SPECIAL ? 0 : 1) - captured.size();
        for (String descriptor : descriptors) {
            List<String> params = Invokedynamics.parameterTypes(descriptor);
            if (params == null || params.size() != expected) {
                return null;
            }
        }
        for (int k = 0; k < captured.size(); k++) {
            captured.set(k, captured.get(k).intern());
        }
        return new Spec(className, intern(interfaces), methodName.intern(), intern(descriptors), dynamicDescriptor.intern(), captured,
                factoryDescriptor.intern(), implKind, implOwner.intern(), implName.intern(), implDescriptor.intern(), implInterface);
    }

    private static String[] intern(List<String> values) {
        String[] result = new String[values.size()];
        for (int k = 0; k < result.length; k++) {
            result[k] = values.get(k).intern();
        }
        return result;
    }

    private static int intConstant(Pool pool, int index) {
        byte[] e = pool.entries.get(index);
        return ((e[1] & 0xff) << 24) | ((e[2] & 0xff) << 16) | ((e[3] & 0xff) << 8) | (e[4] & 0xff);
    }

    // ------------------------------------------------------------------------------------
    // The lambda class
    // ------------------------------------------------------------------------------------

    /** The class file for a recorded lambda, or null when its adaptations are not supported. */
    static byte[] generate(Spec s) throws IOException {
        ConstantPool cp = new ConstantPool();
        int thisClass = cp.classRef(s.className);
        int superClass = cp.classRef(OBJECT);
        boolean singleton = s.captured.isEmpty();
        List<byte[]> methods = new ArrayList<byte[]>();

        // <init>(captured...): store each captured value in its field.
        String initDescriptor = "(" + join(s.captured) + ")V";
        {
            Code c = new Code();
            c.op(0x2a); // aload_0
            c.op(INVOKESPECIAL);
            c.u2(cp.methodRef(OBJECT, "<init>", "()V", false));
            int slot = 1;
            for (int k = 0; k < s.captured.size(); k++) {
                String type = s.captured.get(k);
                c.op(0x2a);
                if (!c.load(type, slot)) {
                    return null;
                }
                c.op(0xb5); // putfield
                c.u2(cp.fieldRef(s.className, "c" + k, type));
                slot += size(type);
            }
            c.op(0xb1); // return
            methods.add(method(cp, 0x1002, "<init>", initDescriptor, c, 4, slot)); // private synthetic
        }
        // static create(captured...): a new instance, or the shared one.
        {
            Code c = new Code();
            int slots = 0;
            if (singleton) {
                c.op(0xb2); // getstatic
                c.u2(cp.fieldRef(s.className, "INSTANCE", "L" + s.className + ";"));
            } else {
                c.op(0xbb); // new
                c.u2(thisClass);
                c.op(0x59); // dup
                for (String type : s.captured) {
                    if (!c.load(type, slots)) {
                        return null;
                    }
                    slots += size(type);
                }
                c.op(INVOKESPECIAL);
                c.u2(cp.methodRef(s.className, "<init>", initDescriptor, false));
            }
            c.op(0xb0); // areturn
            methods.add(method(cp, 0x1009, "create", s.factoryDescriptor, c, 2 + slots, slots)); // public static synthetic
        }
        if (singleton) {
            Code c = new Code();
            c.op(0xbb);
            c.u2(thisClass);
            c.op(0x59);
            c.op(INVOKESPECIAL);
            c.u2(cp.methodRef(s.className, "<init>", "()V", false));
            c.op(0xb3); // putstatic
            c.u2(cp.fieldRef(s.className, "INSTANCE", "L" + s.className + ";"));
            c.op(0xb1);
            methods.add(method(cp, 0x1008, "<clinit>", "()V", c, 2, 0)); // static synthetic
        }
        // The interface method, then its bridges: same body, other parameter and return types.
        for (int k = 0; k < s.methodDescriptors.length; k++) {
            byte[] m = interfaceMethod(cp, s, s.methodDescriptors[k], k == 0 ? 0x0001 : 0x1041); // public (bridge synthetic)
            if (m == null) {
                return null;
            }
            methods.add(m);
        }

        ByteArrayOutputStream fields = new ByteArrayOutputStream();
        DataOutputStream f = new DataOutputStream(fields);
        int fieldCount = 0;
        if (singleton) {
            f.writeShort(0x001a); // private static final
            f.writeShort(cp.utf8("INSTANCE"));
            f.writeShort(cp.utf8("L" + s.className + ";"));
            f.writeShort(0);
            fieldCount++;
        }
        for (int k = 0; k < s.captured.size(); k++) {
            f.writeShort(0x0012); // private final
            f.writeShort(cp.utf8("c" + k));
            f.writeShort(cp.utf8(s.captured.get(k)));
            f.writeShort(0);
            fieldCount++;
        }
        f.flush();
        int[] interfaces = new int[s.interfaces.length];
        for (int k = 0; k < interfaces.length; k++) {
            interfaces[k] = cp.classRef(s.interfaces[k]);
        }

        ByteArrayOutputStream out = new ByteArrayOutputStream(512);
        DataOutputStream d = new DataOutputStream(out);
        d.writeInt(0xCAFEBABE);
        d.writeShort(0);
        d.writeShort(ClassDowngrader.JAVA_17);
        cp.write(d);
        d.writeShort(0x1030); // final super synthetic
        d.writeShort(thisClass);
        d.writeShort(superClass);
        d.writeShort(interfaces.length);
        for (int k : interfaces) {
            d.writeShort(k);
        }
        d.writeShort(fieldCount);
        fields.writeTo(d);
        d.writeShort(methods.size());
        for (byte[] m : methods) {
            d.write(m);
        }
        d.writeShort(0); // attributes
        d.flush();
        return out.toByteArray();
    }

    /** The interface method with the given descriptor, calling the implementation. */
    private static byte[] interfaceMethod(ConstantPool cp, Spec s, String descriptor, int access) throws IOException {
        List<String> params = Invokedynamics.parameterTypes(descriptor);
        List<String> dynamicParams = Invokedynamics.parameterTypes(s.dynamicDescriptor);
        List<String> implParams = Invokedynamics.parameterTypes(s.implDescriptor);
        String returnType = returnType(descriptor);
        String implReturn = returnType(s.implDescriptor);
        String dynamicReturn = returnType(s.dynamicDescriptor);
        if (params == null || dynamicParams == null || implParams == null || returnType == null || implReturn == null) {
            return null;
        }
        List<String> targets = new ArrayList<String>();
        boolean instance = s.implKind == REF_INVOKE_VIRTUAL || s.implKind == REF_INVOKE_INTERFACE || s.implKind == REF_INVOKE_SPECIAL;
        if (instance) {
            targets.add("L" + s.implOwner + ";");
        }
        targets.addAll(implParams);
        if (s.implKind == REF_NEW_INVOKE_SPECIAL) {
            implReturn = "L" + s.implOwner + ";";
        }
        if (s.captured.size() + params.size() != targets.size()) {
            return null;
        }
        Code c = new Code();
        if (s.implKind == REF_NEW_INVOKE_SPECIAL) {
            c.op(0xbb); // new
            c.u2(cp.classRef(s.implOwner));
            c.op(0x59); // dup
        }
        int t = 0;
        for (int k = 0; k < s.captured.size(); k++, t++) {
            String type = s.captured.get(k);
            c.op(0x2a); // aload_0
            c.op(0xb4); // getfield
            c.u2(cp.fieldRef(s.className, "c" + k, type));
            if (!convert(c, cp, type, targets.get(t), null)) {
                return null;
            }
        }
        int slot = 1;
        for (int k = 0; k < params.size(); k++, t++) {
            String type = params.get(k);
            if (!c.load(type, slot)) {
                return null;
            }
            slot += size(type);
            String hint = k < dynamicParams.size() ? dynamicParams.get(k) : null;
            if (!convert(c, cp, type, targets.get(t), hint)) {
                return null;
            }
        }
        switch (s.implKind) {
            case REF_INVOKE_STATIC:
                c.op(INVOKESTATIC);
                c.u2(cp.methodRef(s.implOwner, s.implName, s.implDescriptor, s.implInterface));
                break;
            case REF_INVOKE_VIRTUAL:
                c.op(INVOKEVIRTUAL);
                c.u2(cp.methodRef(s.implOwner, s.implName, s.implDescriptor, false));
                break;
            case REF_INVOKE_SPECIAL:
                // A private method of the host (javac before 11 refers to them this way). Since
                // Java 11, invokevirtual and invokeinterface call private methods without dispatch,
                // as javac's own nestmate calls do.
                if (s.implInterface) {
                    c.op(INVOKEINTERFACE);
                    c.u2(cp.methodRef(s.implOwner, s.implName, s.implDescriptor, true));
                    c.op(1 + slots(implParams));
                    c.op(0);
                } else {
                    c.op(INVOKEVIRTUAL);
                    c.u2(cp.methodRef(s.implOwner, s.implName, s.implDescriptor, false));
                }
                break;
            case REF_INVOKE_INTERFACE:
                c.op(INVOKEINTERFACE);
                c.u2(cp.methodRef(s.implOwner, s.implName, s.implDescriptor, true));
                c.op(1 + slots(implParams));
                c.op(0);
                break;
            case REF_NEW_INVOKE_SPECIAL:
                c.op(INVOKESPECIAL);
                c.u2(cp.methodRef(s.implOwner, "<init>", s.implDescriptor, false));
                break;
            default:
                return null;
        }
        if ("V".equals(returnType)) {
            if (!"V".equals(implReturn)) {
                c.op(size(implReturn) == 2 ? 0x58 : 0x57); // pop2 / pop
            }
            c.op(0xb1); // return
        } else {
            if ("V".equals(implReturn) || !convert(c, cp, implReturn, returnType, dynamicReturn)) {
                return null;
            }
            c.op(returnOpcode(returnType));
        }
        int maxStack = 2 + 2 * (s.captured.size() + params.size()) + 4;
        return method(cp, access, s.methodName, descriptor, c, maxStack, slot);
    }

    /**
     * Converts the value on the stack from one type to another as LambdaMetafactory adapts
     * arguments and results: reference casts, boxing, unboxing (by the instantiated type when it
     * names a box) and primitive widening. False when the conversion is not one of those.
     */
    private static boolean convert(Code c, ConstantPool cp, String from, String to, String hint) throws IOException {
        if (from.equals(to)) {
            return true;
        }
        boolean fromRef = isReference(from);
        boolean toRef = isReference(to);
        if (fromRef && toRef) {
            if (!("L" + OBJECT + ";").equals(to)) {
                c.op(0xc0); // checkcast
                c.u2(cp.classRef(to.startsWith("[") ? to : to.substring(1, to.length() - 1)));
            }
            return true;
        }
        if (!fromRef && !toRef) {
            return widen(c, from, to);
        }
        if (!fromRef) {
            // box, then cast to the target type if it is narrower than the box
            String box = box(from);
            c.op(INVOKESTATIC);
            c.u2(cp.methodRef(box, "valueOf", "(" + from + ")L" + box + ";", false));
            String boxed = "L" + box + ";";
            return boxed.equals(to) || convert(c, cp, boxed, to, null);
        }
        // unbox: by the instantiated box type when there is one, else by the target's own box
        String box = hint != null && hint.startsWith("L") && primitiveOf(hint.substring(1, hint.length() - 1)) != null
                ? hint.substring(1, hint.length() - 1)
                : from.startsWith("L") && primitiveOf(from.substring(1, from.length() - 1)) != null ? from.substring(1, from.length() - 1) : box(to);
        if (box == null) {
            return false;
        }
        String primitive = primitiveOf(box);
        if (!from.equals("L" + box + ";")) {
            c.op(0xc0);
            c.u2(cp.classRef(box));
        }
        c.op(INVOKEVIRTUAL);
        c.u2(cp.methodRef(box, valueMethod(primitive), "()" + primitive, false));
        return widen(c, primitive, to);
    }

    private static boolean widen(Code c, String from, String to) {
        if (from.equals(to)) {
            return true;
        }
        char f = from.charAt(0);
        char t = to.charAt(0);
        boolean intLike = f == 'I' || f == 'S' || f == 'B' || f == 'C';
        if (intLike && t == 'I' && f != 'C') {
            return true; // byte, short -> int: same on the stack
        }
        if (f == 'C' && t == 'I') {
            return true;
        }
        if ((f == 'B' && t == 'S')) {
            return true;
        }
        if (intLike && t == 'J') {
            c.op(0x85); // i2l
            return true;
        }
        if (intLike && t == 'F') {
            c.op(0x86); // i2f
            return true;
        }
        if (intLike && t == 'D') {
            c.op(0x87); // i2d
            return true;
        }
        if (f == 'J' && t == 'F') {
            c.op(0x89); // l2f
            return true;
        }
        if (f == 'J' && t == 'D') {
            c.op(0x8a); // l2d
            return true;
        }
        if (f == 'F' && t == 'D') {
            c.op(0x8d); // f2d
            return true;
        }
        return false;
    }

    private static boolean isReference(String type) {
        return type.startsWith("L") || type.startsWith("[");
    }

    private static String box(String primitive) {
        switch (primitive.charAt(0)) {
            case 'Z': return "java/lang/Boolean";
            case 'B': return "java/lang/Byte";
            case 'S': return "java/lang/Short";
            case 'C': return "java/lang/Character";
            case 'I': return "java/lang/Integer";
            case 'J': return "java/lang/Long";
            case 'F': return "java/lang/Float";
            case 'D': return "java/lang/Double";
            default: return null;
        }
    }

    private static String primitiveOf(String box) {
        switch (box) {
            case "java/lang/Boolean": return "Z";
            case "java/lang/Byte": return "B";
            case "java/lang/Short": return "S";
            case "java/lang/Character": return "C";
            case "java/lang/Integer": return "I";
            case "java/lang/Long": return "J";
            case "java/lang/Float": return "F";
            case "java/lang/Double": return "D";
            default: return null;
        }
    }

    private static String valueMethod(String primitive) {
        switch (primitive.charAt(0)) {
            case 'Z': return "booleanValue";
            case 'B': return "byteValue";
            case 'S': return "shortValue";
            case 'C': return "charValue";
            case 'I': return "intValue";
            case 'J': return "longValue";
            case 'F': return "floatValue";
            default: return "doubleValue";
        }
    }

    private static int returnOpcode(String type) {
        switch (type.charAt(0)) {
            case 'J': return 0xad; // lreturn
            case 'F': return 0xae; // freturn
            case 'D': return 0xaf; // dreturn
            case 'L': case '[': return 0xb0; // areturn
            default: return 0xac; // ireturn
        }
    }

    private static int size(String type) {
        return type.equals("J") || type.equals("D") ? 2 : 1;
    }

    private static int slots(List<String> types) {
        int n = 0;
        for (String t : types) {
            n += size(t);
        }
        return n;
    }

    private static String join(List<String> types) {
        StringBuilder b = new StringBuilder();
        for (String t : types) {
            b.append(t);
        }
        return b.toString();
    }

    private static String returnType(String descriptor) {
        int close = descriptor.lastIndexOf(')');
        return close < 0 ? null : descriptor.substring(close + 1);
    }

    private static byte[] method(ConstantPool cp, int access, String name, String descriptor, Code code, int maxStack, int maxLocals)
            throws IOException {
        byte[] bytes = code.bytes();
        ByteArrayOutputStream method = new ByteArrayOutputStream();
        DataOutputStream m = new DataOutputStream(method);
        m.writeShort(access);
        m.writeShort(cp.utf8(name));
        m.writeShort(cp.utf8(descriptor));
        m.writeShort(1);
        m.writeShort(cp.utf8("Code"));
        m.writeInt(2 + 2 + 4 + bytes.length + 2 + 2);
        m.writeShort(maxStack);
        m.writeShort(Math.max(maxLocals, 1));
        m.writeInt(bytes.length);
        m.write(bytes);
        m.writeShort(0);
        m.writeShort(0);
        m.flush();
        return method.toByteArray();
    }

    /** Bytecode of one method. */
    private static final class Code {
        private final ByteArrayOutputStream bytes = new ByteArrayOutputStream();

        void op(int b) {
            bytes.write(b);
        }

        void u2(int v) {
            bytes.write(v >> 8);
            bytes.write(v);
        }

        /** xload of a local; false when the slot needs a wide instruction. */
        boolean load(String type, int slot) {
            if (slot > 255) {
                return false;
            }
            int base;
            switch (type.charAt(0)) {
                case 'J': base = 0x16; break;
                case 'F': base = 0x17; break;
                case 'D': base = 0x18; break;
                case 'L': case '[': base = 0x19; break;
                default: base = 0x15;
            }
            op(base);
            op(slot);
            return true;
        }

        byte[] bytes() {
            return bytes.toByteArray();
        }
    }

    /** A constant pool built from scratch. */
    private static final class ConstantPool {
        private final ByteArrayOutputStream entries = new ByteArrayOutputStream();
        private final DataOutputStream out = new DataOutputStream(entries);
        private final Map<String, Integer> known = new HashMap<String, Integer>();
        private int count = 1;

        int utf8(String value) throws IOException {
            Integer i = known.get("U" + value);
            if (i != null) {
                return i;
            }
            out.writeByte(ClassFiles.UTF8);
            out.writeUTF(value);
            known.put("U" + value, count);
            return count++;
        }

        int classRef(String internalName) throws IOException {
            Integer i = known.get("C" + internalName);
            if (i != null) {
                return i;
            }
            int name = utf8(internalName);
            out.writeByte(CLASS);
            out.writeShort(name);
            known.put("C" + internalName, count);
            return count++;
        }

        private int nameAndType(String name, String descriptor) throws IOException {
            String key = "N" + name + " " + descriptor;
            Integer i = known.get(key);
            if (i != null) {
                return i;
            }
            int n = utf8(name);
            int d = utf8(descriptor);
            out.writeByte(NAME_AND_TYPE);
            out.writeShort(n);
            out.writeShort(d);
            known.put(key, count);
            return count++;
        }

        int methodRef(String owner, String name, String descriptor, boolean isInterface) throws IOException {
            return member(isInterface ? INTERFACE_METHODREF : METHODREF, owner, name, descriptor);
        }

        int fieldRef(String owner, String name, String descriptor) throws IOException {
            return member(ClassFiles.FIELDREF, owner, name, descriptor);
        }

        private int member(int tag, String owner, String name, String descriptor) throws IOException {
            String key = "M" + tag + owner + "." + name + descriptor;
            Integer i = known.get(key);
            if (i != null) {
                return i;
            }
            int c = classRef(owner);
            int nat = nameAndType(name, descriptor);
            out.writeByte(tag);
            out.writeShort(c);
            out.writeShort(nat);
            known.put(key, count);
            return count++;
        }

        void write(DataOutputStream d) throws IOException {
            out.flush();
            d.writeShort(count);
            entries.writeTo(d);
        }
    }

    // ------------------------------------------------------------------------------------
    // Class file plumbing shared with Invokedynamics
    // ------------------------------------------------------------------------------------

    private static List<int[]> bootstrapMethods(Pool pool, byte[] rest, int methodsEnd) {
        int attributes = u2(rest, methodsEnd);
        int q = methodsEnd + 2;
        for (int a = 0; a < attributes; a++) {
            if ("BootstrapMethods".equals(pool.utf8(u2(rest, q)))) {
                List<int[]> bootstraps = new ArrayList<int[]>();
                int r = q + 8;
                for (int k = u2(rest, q + 6); k > 0; k--) {
                    int args = u2(rest, r + 2);
                    int[] entry = new int[args + 1];
                    entry[0] = u2(rest, r);
                    for (int j = 0; j < args; j++) {
                        entry[j + 1] = u2(rest, r + 4 + j * 2);
                    }
                    bootstraps.add(entry);
                    r += 4 + args * 2;
                }
                return bootstraps;
            }
            q += 6 + u4(rest, q + 2);
        }
        return null;
    }

    private static void rewriteCalls(byte[] b, Pool pool, int methodsStart, Map<Integer, Integer> replaced) {
        int p = methodsStart;
        int methods = u2(b, p);
        p += 2;
        for (int m = 0; m < methods; m++) {
            int attributes = u2(b, p + 6);
            p += 8;
            for (int a = 0; a < attributes; a++) {
                int length = u4(b, p + 2);
                if ("Code".equals(pool.utf8(u2(b, p)))) {
                    int codeLength = u4(b, p + 10);
                    int code = p + 14;
                    for (int pc = 0; pc < codeLength; pc += instructionLength(b, code, pc)) {
                        if ((b[code + pc] & 0xff) != INVOKEDYNAMIC) {
                            continue;
                        }
                        Integer target = replaced.get(u2(b, code + pc + 1));
                        if (target != null) {
                            b[code + pc] = (byte) INVOKESTATIC;
                            b[code + pc + 1] = (byte) (target >> 8);
                            b[code + pc + 2] = (byte) (int) target;
                            b[code + pc + 3] = 0; // nop
                            b[code + pc + 4] = 0; // nop
                        }
                    }
                }
                p += 6 + length;
            }
        }
    }
}
