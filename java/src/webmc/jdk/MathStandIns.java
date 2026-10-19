package webmc.jdk;

/**
 * Math (and StrictMath) functions for the game's classes (see {@code webmc.StandIns}).
 *
 * <ul>
 *   <li>log1p, sinh and cosh: CheerpJ's compiled code calls them through JavaScript imports the
 *       runtime does not provide ("Missing import: jlog1p"); the result is 0, and the method may
 *       go wrong after it. These follow fdlibm's algorithms using exp, expm1 and log, which work.</li>
 *   <li>floor and ceil: Java 17 computes them in Java from the bits of the double, which CheerpJ
 *       runs slowly, and the game floors coordinates everywhere (Mth.floor), noise generation
 *       most of all. Values in the int range are rounded through an int.</li>
 * </ul>
 */
public final class MathStandIns {
    private MathStandIns() {
    }

    public static double floor(double a) {
        if (a > -0x1p31 && a < 0x1p31) { // false for NaN
            if (a == 0) {
                return a; // keeps -0.0
            }
            int i = (int) a; // toward zero
            return i > a ? (double) i - 1 : i;
        }
        return StrictMath.floor(a);
    }

    public static double ceil(double a) {
        if (a > -0x1p31 && a < 0x1p31) {
            if (a == 0) {
                return a;
            }
            int i = (int) a;
            if (i < a) {
                return (double) i + 1;
            }
            return i == 0 ? -0.0 : i; // (-1, 0) rounds up to -0.0
        }
        return StrictMath.ceil(a);
    }

    public static double log1p(double x) {
        if (!(x > -1)) {
            return x == -1 ? Double.NEGATIVE_INFINITY : Double.NaN;
        }
        if (x == Double.POSITIVE_INFINITY) {
            return x;
        }
        double u = 1 + x;
        if (u == 1) {
            return x; // |x| below half an ulp of 1, and -0.0
        }
        return Math.log(u) * (x / (u - 1)); // corrects log(u) for the rounding of 1 + x
    }

    public static double sinh(double x) {
        double a = Math.abs(x);
        double h = x < 0 ? -0.5 : 0.5;
        if (a < 22) {
            if (a < 0x1p-28) {
                return x;
            }
            double t = Math.expm1(a);
            return a < 1 ? h * (2 * t - t * t / (t + 1)) : h * (t + t / (t + 1));
        }
        if (a < 709.782712893384) {
            return h * Math.exp(a);
        }
        double w = Math.exp(0.5 * a); // NaN and overflow go through here too
        return (h * w) * w;
    }

    public static double cosh(double x) {
        double a = Math.abs(x);
        if (a < 0.34657359027997264) { // ln(2) / 2
            double t = Math.expm1(a);
            double w = 1 + t;
            return a < 0x1p-55 ? w : 1 + (t * t) / (w + w);
        }
        if (a < 22) {
            double t = Math.exp(a);
            return 0.5 * t + 0.5 / t;
        }
        if (a < 709.782712893384) {
            return 0.5 * Math.exp(a);
        }
        double w = Math.exp(0.5 * a);
        return (0.5 * w) * w;
    }
}
