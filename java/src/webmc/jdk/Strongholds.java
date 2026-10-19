package webmc.jdk;

import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.util.ArrayList;
import java.util.List;

/**
 * The first chunk generated waits until the game has worked out where all 128 strongholds go,
 * each with a biome search around its ring position: in the browser that takes from many
 * minutes (1.20+) up to an hour (1.16's layered biomes) before the first world can open. With
 * the default layout the first ring lies 88 - 168 chunks from the origin and the biome search
 * moves a stronghold by at most 10 chunks, so no stronghold starts closer than that.
 * webmc.GamePatches lets ChunkGenerator.hasStronghold (1.16 - 1.18.1) and
 * ConcentricRingsStructurePlacement.isPlacementChunk (1.18.2+) answer such chunks without the
 * positions, which are still worked out exactly when a chunk farther out asks.
 */
public final class Strongholds {
    /** Chunks from the origin within which no stronghold can start (with margin). */
    private static final int NONE_WITHIN = 72;
    private static volatile Field[] coordinates;

    private Strongholds() {
    }

    /** Whether a ChunkPos lies too close to the origin for a stronghold. */
    public static boolean nearOrigin(Object chunkPos) {
        try {
            Field[] xz = coordinates;
            if (xz == null || xz[0].getDeclaringClass() != chunkPos.getClass()) {
                coordinates = xz = intFields(chunkPos.getClass());
            }
            long x = xz[0].getInt(chunkPos);
            long z = xz[1].getInt(chunkPos);
            return x * x + z * z < (long) NONE_WITHIN * NONE_WITHIN;
        } catch (ReflectiveOperationException | RuntimeException e) {
            return false;
        }
    }

    private static volatile Class<?> ringClass;
    private static volatile Field ringDistance;

    /**
     * ConcentricRingsStructurePlacement.isPlacementChunk (1.18.2+; strongholds): whether chunk
     * (x, z) lies too close to the origin for the placement's first ring. Ring i lies
     * 4 * distance + 6 * i * distance chunks out, give or take 1.25 * distance, and the biome
     * search moves a position by at most 10 chunks.
     */
    public static boolean ringNearOrigin(Object placement, int x, int z) {
        try {
            Field distanceField = ringDistance;
            if (ringClass != placement.getClass()) {
                distanceField = intFields(placement.getClass())[0];
                ringDistance = distanceField;
                ringClass = placement.getClass();
            }
            long noneWithin = (long) (2.75 * distanceField.getInt(placement)) - 12;
            return noneWithin > 0 && (long) x * x + (long) z * z < noneWithin * noneWithin;
        } catch (ReflectiveOperationException | RuntimeException e) {
            return false;
        }
    }

    /** ChunkPos's x and z (or a placement's distance): its first instance fields of type int. */
    private static Field[] intFields(Class<?> type) throws NoSuchFieldException {
        List<Field> found = new ArrayList<Field>();
        for (Field field : type.getDeclaredFields()) {
            if (field.getType() == int.class && !Modifier.isStatic(field.getModifiers())) {
                found.add(field);
            }
        }
        if (found.size() < 2) {
            throw new NoSuchFieldException("x/z in " + type.getName());
        }
        return new Field[] {found.get(0), found.get(1)};
    }
}
