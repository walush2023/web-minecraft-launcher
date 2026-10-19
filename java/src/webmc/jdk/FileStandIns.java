package webmc.jdk;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.CopyOption;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.FileSystems;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;

/**
 * java.nio.file.Files methods for the game's classes (see {@code webmc.StandIns}).
 *
 * <p>{@code Files.copy(Path, Path, CopyOption...)} between files fails in CheerpJ ("Invalid
 * argument": the JDK's UnixCopyFile relies on a native file-to-file transfer the browser runtime
 * lacks), and 26.x copies each file it changes while upgrading an older world, so no older world
 * could be opened. This copy goes through streams; with COPY_ATTRIBUTES it copies the modification
 * time when it can (CheerpJ cannot set file times either).
 */
public final class FileStandIns {
    private FileStandIns() {
    }

    public static Path copy(Path source, Path target, CopyOption... options) throws IOException {
        if (source.getFileSystem() != FileSystems.getDefault() || target.getFileSystem() != FileSystems.getDefault()) {
            return Files.copy(source, target, options); // other providers copy by themselves
        }
        boolean replace = false;
        boolean attributes = false;
        for (CopyOption option : options) {
            if (option == StandardCopyOption.REPLACE_EXISTING) {
                replace = true;
            } else if (option == StandardCopyOption.COPY_ATTRIBUTES) {
                attributes = true;
            }
        }
        if (Files.exists(target, LinkOption.NOFOLLOW_LINKS)) {
            if (!replace) {
                throw new FileAlreadyExistsException(target.toString());
            }
            Files.delete(target); // as the JDK does: fails for a directory that is not empty
        }
        if (Files.isDirectory(source)) {
            Files.createDirectory(target);
        } else {
            try (InputStream in = Files.newInputStream(source);
                 OutputStream out = Files.newOutputStream(target, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)) {
                byte[] buffer = new byte[65536];
                for (int n; (n = in.read(buffer)) > 0;) {
                    out.write(buffer, 0, n);
                }
            }
        }
        if (attributes) {
            try {
                Files.setLastModifiedTime(target, Files.getLastModifiedTime(source));
            } catch (IOException e) {
                // CheerpJ cannot set file times ("Invalid argument" as well): the copy itself is complete
            }
        }
        return target;
    }

    /**
     * CheerpJ has no hard links, but its {@code link} call reports success without creating
     * anything ("Missing import: path_symlink" in the console). 26.x checks whether hard links work
     * before upgrading a world, then links the files it keeps into the new world folder and deletes
     * the old one, so the upgraded world lost its region files. Reporting them unsupported makes it
     * move the files instead, as on file systems without hard links.
     */
    public static Path createLink(Path link, Path existing) throws IOException {
        if (link.getFileSystem() != FileSystems.getDefault()) {
            return Files.createLink(link, existing);
        }
        throw new UnsupportedOperationException("No hard links in the browser's file system");
    }
}
