package webmc;

import java.io.IOException;
import java.net.ProtocolFamily;
import java.nio.channels.DatagramChannel;
import java.nio.channels.IllegalSelectorException;
import java.nio.channels.Pipe;
import java.nio.channels.SelectionKey;
import java.nio.channels.Selector;
import java.nio.channels.ServerSocketChannel;
import java.nio.channels.SocketChannel;
import java.nio.channels.spi.AbstractSelectableChannel;
import java.nio.channels.spi.AbstractSelector;
import java.nio.channels.spi.SelectorProvider;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;

/**
 * NIO selector provider for the browser JVM, installed with
 * {@code -Djava.nio.channels.spi.SelectorProvider=webmc.NullSelectorProvider}.
 *
 * <p>CheerpJ has no native NIO selector, but the integrated server (singleplayer) creates
 * Netty NIO event loops and uses them to drive in-memory "local" channels, which only need a
 * selector for timed waits and wake-ups. Real sockets are unavailable in the browser, so
 * opening one fails with an IOException, which the game reports as a connection error.
 */
public final class NullSelectorProvider extends SelectorProvider {
    private static IOException unavailable() {
        return new IOException("Network sockets are not available in the browser");
    }

    @Override
    public DatagramChannel openDatagramChannel() throws IOException {
        throw unavailable();
    }

    @Override
    public DatagramChannel openDatagramChannel(ProtocolFamily family) throws IOException {
        throw unavailable();
    }

    @Override
    public Pipe openPipe() throws IOException {
        throw unavailable();
    }

    @Override
    public AbstractSelector openSelector() {
        return new NullSelector(this);
    }

    @Override
    public ServerSocketChannel openServerSocketChannel() throws IOException {
        throw unavailable();
    }

    @Override
    public SocketChannel openSocketChannel() throws IOException {
        throw unavailable();
    }

    /** A selector with no channels: select() is a timed, interruptible wait. */
    private static final class NullSelector extends AbstractSelector {
        private final Object lock = new Object();
        private final Set<SelectionKey> selected = new HashSet<SelectionKey>();
        private boolean woken;

        NullSelector(SelectorProvider provider) {
            super(provider);
        }

        @Override
        protected void implCloseSelector() {
            wakeup();
        }

        @Override
        protected SelectionKey register(AbstractSelectableChannel channel, int ops, Object attachment) {
            throw new IllegalSelectorException();
        }

        @Override
        public Set<SelectionKey> keys() {
            return Collections.emptySet();
        }

        @Override
        public Set<SelectionKey> selectedKeys() {
            return selected;
        }

        @Override
        public int selectNow() {
            synchronized (lock) {
                woken = false;
            }
            return 0;
        }

        @Override
        public int select(long timeout) throws IOException {
            if (timeout < 0) {
                throw new IllegalArgumentException("Negative timeout");
            }
            synchronized (lock) {
                if (!woken && isOpen()) {
                    try {
                        lock.wait(timeout);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                }
                woken = false;
            }
            return 0;
        }

        @Override
        public int select() throws IOException {
            return select(0);
        }

        @Override
        public Selector wakeup() {
            synchronized (lock) {
                woken = true;
                lock.notifyAll();
            }
            return this;
        }
    }
}
