// Kosmik UI: look picker shared by Kosmik Voice and Kosmik Layouts.
// The same file lives in both projects; keep the copies identical.
// Load it as a plain <script> in <head> (not a module) so the look is set before the first paint.
(function () {
  var KEY = "kosmik.look";
  var LOOKS = ["studio", "daylight", "pixel"];

  function stored() {
    try {
      return localStorage.getItem(KEY);
    } catch (e) {
      return null; // storage blocked: default look
    }
  }
  function apply(name) {
    document.documentElement.setAttribute("data-ui", LOOKS.indexOf(name) >= 0 ? name : LOOKS[0]);
  }
  function setLook(name) {
    apply(name);
    try {
      localStorage.setItem(KEY, name);
    } catch (e) {
      // not remembered, still applied
    }
    document.dispatchEvent(new CustomEvent("kosmik:look", { detail: name }));
  }

  // ?look=pixel in the address picks a look directly (handy for screenshots and bookmarks).
  var asked = new URLSearchParams(location.search).get("look");
  if (LOOKS.indexOf(asked) >= 0) setLook(asked);
  else apply(stored());

  /**
   * Fill a container with the three look buttons.
   * labels: { studio: "Studio", daylight: "Daylight", pixel: "Pixel" }
   */
  function mountLooks(container, labels) {
    container.textContent = "";
    container.classList.add("k-looks");
    LOOKS.forEach(function (name) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "k-look";
      b.setAttribute("aria-pressed", String(document.documentElement.getAttribute("data-ui") === name));
      var sw = document.createElement("span");
      sw.className = "k-swatch sw-" + name;
      sw.setAttribute("aria-hidden", "true");
      b.appendChild(sw);
      b.appendChild(document.createTextNode(labels[name] || name));
      b.addEventListener("click", function () {
        setLook(name);
        container.querySelectorAll(".k-look").forEach(function (x) {
          x.setAttribute("aria-pressed", String(x === b));
        });
      });
      container.appendChild(b);
    });
  }

  // Menus (<details class="k-menu">) close on outside click and on Escape.
  document.addEventListener("click", function (e) {
    document.querySelectorAll("details.k-menu[open]").forEach(function (m) {
      if (!m.contains(e.target)) m.open = false;
    });
  });
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    document.querySelectorAll("details.k-menu[open]").forEach(function (m) {
      m.open = false;
      m.querySelector("summary").focus();
    });
  });

  window.KosmikUI = { looks: LOOKS, setLook: setLook, mountLooks: mountLooks };
})();
