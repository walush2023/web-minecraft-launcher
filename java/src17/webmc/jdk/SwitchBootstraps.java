package webmc.jdk;

import java.lang.constant.ClassDesc;
import java.lang.Enum.EnumDesc;
import java.lang.invoke.CallSite;
import java.lang.invoke.ConstantCallSite;
import java.lang.invoke.MethodHandle;
import java.lang.invoke.MethodHandles;
import java.lang.invoke.MethodType;

/**
 * The bootstrap methods of pattern-matching switches (java.lang.runtime.SwitchBootstraps), as
 * Java 21+ defines them. The Java 17 runtime has a preview version that returns a call site of
 * type (Object, int)int whatever the switch's selector type is, so a switch on, say, a
 * Throwable fails to link; it also lacks the enum constant labels Java 21 added.
 *
 * <p>Both bootstraps return the index of the first label from {@code restart} on that matches the
 * selector, {@code labels.length} when none does, and -1 for null. {@code webmc.Invokedynamics}
 * replaces most call sites with direct calls of typeIndex and enumIndex.
 */
public final class SwitchBootstraps {
    private static final MethodHandle TYPE_SWITCH;
    private static final MethodHandle ENUM_SWITCH;

    static {
        try {
            MethodHandles.Lookup lookup = MethodHandles.lookup();
            MethodType type = MethodType.methodType(int.class, Object.class, int.class, Object[].class);
            TYPE_SWITCH = lookup.findStatic(SwitchBootstraps.class, "typeIndex", type);
            ENUM_SWITCH = lookup.findStatic(SwitchBootstraps.class, "enumIndex", type);
        } catch (ReflectiveOperationException e) {
            throw new ExceptionInInitializerError(e);
        }
    }

    private SwitchBootstraps() {
    }

    public static CallSite typeSwitch(MethodHandles.Lookup lookup, String name, MethodType type, Object... labels) {
        return new ConstantCallSite(MethodHandles.insertArguments(TYPE_SWITCH, 2, (Object) labels.clone()).asType(type));
    }

    public static CallSite enumSwitch(MethodHandles.Lookup lookup, String name, MethodType type, Object... labels) {
        return new ConstantCallSite(MethodHandles.insertArguments(ENUM_SWITCH, 2, (Object) labels.clone()).asType(type));
    }

    public static int typeIndex(Object target, int restart, Object[] labels) {
        if (target == null) {
            return -1;
        }
        for (int i = Math.max(restart, 0); i < labels.length; i++) {
            if (matches(target, labels[i])) {
                return i;
            }
        }
        return labels.length;
    }

    public static int enumIndex(Object target, int restart, Object[] labels) {
        if (target == null) {
            return -1;
        }
        for (int i = Math.max(restart, 0); i < labels.length; i++) {
            Object label = labels[i];
            if (label instanceof String ? target instanceof Enum && ((Enum<?>) target).name().equals(label) : matches(target, label)) {
                return i;
            }
        }
        return labels.length;
    }

    private static boolean matches(Object target, Object label) {
        if (label instanceof Class) {
            return ((Class<?>) label).isInstance(target);
        }
        if (label instanceof String) {
            return label.equals(target);
        }
        if (label instanceof Integer) {
            int value = (Integer) label;
            if (target instanceof Character) {
                return (Character) target == value;
            }
            return (target instanceof Integer || target instanceof Short || target instanceof Byte) && ((Number) target).intValue() == value;
        }
        if (label instanceof EnumDesc) {
            if (!(target instanceof Enum)) {
                return false;
            }
            EnumDesc<?> desc = (EnumDesc<?>) label;
            Enum<?> constant = (Enum<?>) target;
            return constant.name().equals(desc.constantName())
                    && sameClass(constant.getDeclaringClass(), desc.constantType());
        }
        if (label instanceof Long || label instanceof Float || label instanceof Double || label instanceof Boolean) {
            return label.equals(target); // Java 23+ primitive patterns
        }
        return false;
    }

    private static boolean sameClass(Class<?> type, ClassDesc desc) {
        return type.describeConstable().map(desc::equals).orElse(false);
    }
}
