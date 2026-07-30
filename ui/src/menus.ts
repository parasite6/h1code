import { CommandRegistry, type CommandId } from "./commands";

export type MenuItem =
  | { kind: "command"; command: CommandId }
  | { kind: "separator" }
  | { kind: "submenu"; id: string; label: string; items: () => MenuItem[] };

export interface MenuDefinition {
  id: string;
  label: string;
  items: () => MenuItem[];
}

interface RenderedItem {
  element: HTMLButtonElement;
  item: MenuItem;
  enabled: boolean;
}

interface OpenMenu {
  id: string;
  rootButton: HTMLButtonElement;
  panel: HTMLElement;
  items: RenderedItem[];
  activeIndex: number;
  parent?: OpenMenu;
  submenuOwner?: HTMLButtonElement;
}

interface MenuBinding {
  rootButton: HTMLButtonElement;
  definition: MenuDefinition;
}

export function mountMenus(
  host: HTMLElement,
  registry: CommandRegistry,
  definitions: MenuDefinition[],
): void {
  const bindings: MenuBinding[] = [];
  let openMenu: OpenMenu | null = null;
  let childMenu: OpenMenu | null = null;

  host.innerHTML = "";
  host.setAttribute("role", "menubar");

  for (const definition of definitions) {
    const button = document.createElement("button");
    button.className = "menubar-button";
    button.type = "button";
    button.textContent = definition.label;
    button.setAttribute("role", "menuitem");
    button.setAttribute("aria-haspopup", "true");
    button.setAttribute("aria-expanded", "false");
    host.appendChild(button);

    const binding = { rootButton: button, definition };
    bindings.push(binding);

    button.addEventListener("click", (event) => {
      event.stopPropagation();
      if (openMenu?.id === definition.id && !childMenu) {
        closeAll();
        return;
      }
      openRoot(binding, 0);
    });

    button.addEventListener("mouseenter", () => {
      if (!openMenu) return;
      openRoot(binding, 0);
    });
  }

  window.addEventListener("keydown", (event) => {
    if (event.key === "F10") {
      event.preventDefault();
      const file = bindings.find((binding) => binding.definition.id === "file");
      if (file) openRoot(file, 0);
      return;
    }
    if (event.altKey && !event.ctrlKey && !event.metaKey && event.key.length === 1) {
      const letter = event.key.toLowerCase();
      const match = bindings.find((binding) =>
        binding.definition.label.toLowerCase().startsWith(letter)
      );
      if (match) {
        event.preventDefault();
        openRoot(match, 0);
        return;
      }
    }

    const active = childMenu ?? openMenu;
    if (!active) return;

    if (event.key === "Escape") {
      event.preventDefault();
      if (childMenu) {
        closeChild();
        focusItem(active.parent ?? openMenu, "current");
      } else {
        closeAll();
      }
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      move(active, 1);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      move(active, -1);
      return;
    }

    if (event.key === "ArrowRight") {
      event.preventDefault();
      const rendered = active.items[active.activeIndex];
      if (rendered?.item.kind === "submenu" && rendered.enabled) {
        openSubmenu(active, rendered);
        return;
      }
      const nextRoot = nextBinding(1);
      if (nextRoot) openRoot(nextRoot, 0);
      return;
    }

    if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (childMenu) {
        closeChild();
        focusItem(openMenu, "current");
        return;
      }
      const previousRoot = nextBinding(-1);
      if (previousRoot) openRoot(previousRoot, 0);
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const rendered = active.items[active.activeIndex];
      if (rendered) activate(active, rendered);
    }
  }, true);

  document.addEventListener("mousedown", (event) => {
    if (!openMenu) return;
    const target = event.target as Node;
    if (host.contains(target) || openMenu.panel.contains(target) || childMenu?.panel.contains(target)) return;
    closeAll();
  });

  window.addEventListener("blur", closeAll);
  window.addEventListener("resize", repositionOpenMenus);
  window.addEventListener("ide:zoomchange", () => {
    requestAnimationFrame(repositionOpenMenus);
  });

  function openRoot(binding: MenuBinding, preferredIndex: number): void {
    closeChild();
    if (openMenu) closePanel(openMenu);
    openMenu = renderMenu(
      binding.definition.id,
      binding.rootButton,
      binding.definition.items(),
      undefined,
      undefined,
    );
    binding.rootButton.classList.add("active");
    binding.rootButton.setAttribute("aria-expanded", "true");
    setActive(openMenu, firstEnabledIndex(openMenu.items, preferredIndex));
  }

  function openSubmenu(parent: OpenMenu, rendered: RenderedItem): void {
    if (rendered.item.kind !== "submenu") return;
    closeChild();
    childMenu = renderMenu(
      rendered.item.id,
      parent.rootButton,
      rendered.item.items(),
      parent,
      rendered.element,
    );
    setActive(childMenu, firstEnabledIndex(childMenu.items, 0));
  }

  function renderMenu(
    id: string,
    rootButton: HTMLButtonElement,
    items: MenuItem[],
    parent?: OpenMenu,
    submenuOwner?: HTMLButtonElement,
  ): OpenMenu {
    const panel = document.createElement("div");
    panel.className = "ide-menu";
    panel.setAttribute("role", "menu");
    panel.dataset.menuId = id;

    const renderedItems: RenderedItem[] = [];
    for (const item of items) {
      if (item.kind === "separator") {
        const separator = document.createElement("div");
        separator.className = "ide-menu-separator";
        separator.setAttribute("role", "separator");
        panel.appendChild(separator);
        continue;
      }

      const button = document.createElement("button");
      button.type = "button";
      button.className = "ide-menu-item";
      button.setAttribute("role", "menuitem");

      let enabled = true;
      let label = "";
      let shortcut = "";
      if (item.kind === "command") {
        const command = registry.get(item.command);
        label = command?.label ?? item.command;
        shortcut = command?.shortcut ?? "";
        enabled = Boolean(command && registry.enabled(item.command));
      } else {
        label = item.label;
      }

      button.disabled = !enabled;
      button.tabIndex = -1;

      const labelSpan = document.createElement("span");
      labelSpan.className = "ide-menu-label";
      labelSpan.textContent = label;
      button.appendChild(labelSpan);

      const shortcutSpan = document.createElement("span");
      shortcutSpan.className = "ide-menu-shortcut";
      shortcutSpan.textContent = shortcut;
      button.appendChild(shortcutSpan);

      if (item.kind === "submenu") {
        const arrow = document.createElement("span");
        arrow.className = "ide-menu-submenu-arrow";
        arrow.textContent = ">";
        button.appendChild(arrow);
        button.setAttribute("aria-haspopup", "true");
      }

      const rendered = { element: button, item, enabled };
      renderedItems.push(rendered);

      button.addEventListener("mouseenter", () => {
        const menu = parent ? childMenu ?? parent : openMenu;
        if (!menu) return;
        setActive(menu, renderedItems.indexOf(rendered));
        if (item.kind === "submenu" && enabled) {
          openSubmenu(menu, rendered);
        } else if (!parent) {
          closeChild();
        }
      });

      button.addEventListener("click", (event) => {
        event.stopPropagation();
        activate(parent ? childMenu ?? parent : openMenu, rendered);
      });

      panel.appendChild(button);
    }

    document.body.appendChild(panel);
    const menu = {
      id,
      rootButton,
      panel,
      items: renderedItems,
      activeIndex: -1,
      parent,
      submenuOwner,
    };
    positionMenu(menu);
    return menu;
  }

  function activate(menu: OpenMenu | null, rendered: RenderedItem): void {
    if (!menu || !rendered.enabled) return;
    if (rendered.item.kind === "submenu") {
      openSubmenu(menu, rendered);
      return;
    }
    if (rendered.item.kind !== "command") return;
    const commandId = rendered.item.command;
    registry.execute(commandId).catch((error) => {
      console.error(`Command failed: ${commandId}`, error);
    });
    closeAll();
  }

  function positionMenu(menu: OpenMenu): void {
    const anchorRect = menu.submenuOwner
      ? menu.submenuOwner.getBoundingClientRect()
      : menu.rootButton.getBoundingClientRect();
    const desiredX = menu.submenuOwner ? anchorRect.right - 2 : anchorRect.left;
    const desiredY = menu.submenuOwner ? anchorRect.top - 4 : anchorRect.bottom;
    placePanel(menu.panel, desiredX, desiredY);
  }

  function placePanel(panel: HTMLElement, visualX: number, visualY: number): void {
    const zoom = currentCssZoom();
    panel.style.left = `${Math.max(2, visualX) / zoom}px`;
    panel.style.top = `${Math.max(2, visualY) / zoom}px`;
    const rect = panel.getBoundingClientRect();
    const left = Math.min(Math.max(2, visualX), window.innerWidth - rect.width - 2);
    const top = Math.min(Math.max(2, visualY), window.innerHeight - rect.height - 2);
    panel.style.left = `${left / zoom}px`;
    panel.style.top = `${top / zoom}px`;
  }

  function currentCssZoom(): number {
    const rawZoom =
      (document.documentElement.style as CSSStyleDeclaration & { zoom?: string }).zoom || "1";
    const zoom = Number.parseFloat(rawZoom);
    return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  }

  function repositionOpenMenus(): void {
    if (!openMenu) return;
    positionMenu(openMenu);
    if (childMenu) positionMenu(childMenu);
  }

  function move(menu: OpenMenu, delta: number): void {
    const enabled = menu.items.filter((item) => item.enabled);
    if (enabled.length === 0) return;
    let index = menu.activeIndex;
    for (let i = 0; i < menu.items.length; i += 1) {
      index = (index + delta + menu.items.length) % menu.items.length;
      if (menu.items[index].enabled) {
        setActive(menu, index);
        return;
      }
    }
  }

  function setActive(menu: OpenMenu, index: number): void {
    menu.items.forEach((item) => item.element.classList.remove("active"));
    menu.activeIndex = index;
    const active = menu.items[index];
    if (!active) return;
    active.element.classList.add("active");
    active.element.focus({ preventScroll: true });
  }

  function focusItem(menu: OpenMenu | null, mode: "current"): void {
    if (!menu || mode !== "current") return;
    setActive(menu, menu.activeIndex >= 0 ? menu.activeIndex : firstEnabledIndex(menu.items, 0));
  }

  function firstEnabledIndex(items: RenderedItem[], preferredIndex: number): number {
    if (items[preferredIndex]?.enabled) return preferredIndex;
    const index = items.findIndex((item) => item.enabled);
    return index >= 0 ? index : 0;
  }

  function nextBinding(delta: number): MenuBinding | null {
    if (!openMenu) return null;
    const index = bindings.findIndex((binding) => binding.rootButton === openMenu?.rootButton);
    if (index < 0) return null;
    return bindings[(index + delta + bindings.length) % bindings.length] ?? null;
  }

  function closeChild(): void {
    if (!childMenu) return;
    closePanel(childMenu);
    childMenu = null;
  }

  function closeAll(): void {
    closeChild();
    if (openMenu) {
      closePanel(openMenu);
      openMenu = null;
    }
  }

  function closePanel(menu: OpenMenu): void {
    menu.panel.remove();
    menu.submenuOwner?.classList.remove("active");
    if (!menu.parent) {
      menu.rootButton.classList.remove("active");
      menu.rootButton.setAttribute("aria-expanded", "false");
    }
  }
}

export const menuCommand = (command: CommandId): MenuItem => ({ kind: "command", command });
export const menuSeparator = (): MenuItem => ({ kind: "separator" });
export const menuSubmenu = (id: string, label: string, items: () => MenuItem[]): MenuItem => ({
  kind: "submenu",
  id,
  label,
  items,
});
