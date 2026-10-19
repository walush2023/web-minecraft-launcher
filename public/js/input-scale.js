// The game is rendered at a reduced resolution and enlarged with a CSS transform.
// CheerpJ maps pointer events with client coordinates and ignores transforms, so menus
// would receive clicks at the wrong place. This wraps every mouse/pointer handler that
// is registered after install() (addEventListener and on* properties) so it sees
// coordinates in the display's own, unscaled space.

const MOUSE_EVENTS = [
  'mousedown', 'mouseup', 'mousemove', 'mouseover', 'mouseout', 'mouseenter', 'mouseleave',
  'click', 'dblclick', 'contextmenu', 'wheel',
  'pointerdown', 'pointerup', 'pointermove', 'pointerover', 'pointerout', 'pointerenter', 'pointerleave', 'pointercancel',
];
const MOUSE_EVENT_SET = new Set(MOUSE_EVENTS);

let state = null; // { element, scale }
const wrapped = new WeakMap();

function correctedEvent(event) {
  const { element, scale } = state;
  if (!element || scale === 1) return event;
  const rect = element.getBoundingClientRect();
  const clientX = rect.left + (event.clientX - rect.left) / scale;
  const clientY = rect.top + (event.clientY - rect.top) / scale;
  let offset = null;
  const values = {
    clientX,
    clientY,
    x: clientX,
    y: clientY,
    pageX: clientX + window.scrollX,
    pageY: clientY + window.scrollY,
    movementX: event.movementX / scale,
    movementY: event.movementY / scale,
  };
  const offsetFor = (axis) => {
    if (!offset) {
      const target = event.target instanceof Element ? event.target.getBoundingClientRect() : rect;
      offset = { x: (event.clientX - target.left) / scale, y: (event.clientY - target.top) / scale };
    }
    return offset[axis];
  };
  return new Proxy(event, {
    get(target, prop) {
      if (Object.hasOwn(values, prop)) return values[prop];
      if (prop === 'offsetX' || prop === 'layerX') return offsetFor('x');
      if (prop === 'offsetY' || prop === 'layerY') return offsetFor('y');
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function adjust(event) {
  return state && event instanceof MouseEvent ? correctedEvent(event) : event;
}

function wrap(listener) {
  if (wrapped.has(listener)) return wrapped.get(listener);
  const fn = function (event) {
    return typeof listener === 'function' ? listener.call(this, adjust(event)) : listener.handleEvent(adjust(event));
  };
  wrapped.set(listener, fn);
  return fn;
}

/** Must run before CheerpJ registers its input handlers. */
export function installInputScaling() {
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (listener && MOUSE_EVENT_SET.has(type)) return add.call(this, type, wrap(listener), options);
    return add.call(this, type, listener, options);
  };
  EventTarget.prototype.removeEventListener = function (type, listener, options) {
    if (listener && MOUSE_EVENT_SET.has(type) && wrapped.has(listener)) return remove.call(this, type, wrapped.get(listener), options);
    return remove.call(this, type, listener, options);
  };

  // CheerpJ's X11 windows use element.onpointerdown = ... style handlers.
  for (const type of MOUSE_EVENTS) {
    const prop = `on${type}`;
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop);
    if (!descriptor?.set) continue;
    const originals = new WeakMap();
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      enumerable: descriptor.enumerable,
      get() {
        const current = descriptor.get.call(this);
        return current && originals.has(current) ? originals.get(current) : current;
      },
      set(handler) {
        if (typeof handler !== 'function') return descriptor.set.call(this, handler);
        const fn = function (event) {
          return handler.call(this, adjust(event));
        };
        originals.set(fn, handler);
        descriptor.set.call(this, fn);
      },
    });
  }
}

/** Sets the scaled element and its current CSS scale factor. */
export function setInputScale(element, scale) {
  state = { element, scale };
}
