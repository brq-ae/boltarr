// Press-and-hold eye for password boxes marked data-peek (login page and
// Settings → Login). The password shows only while the eye is held down
// (mouse, touch, or Space/Enter), then hides again.
const EYE_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/>' +
  '<circle cx="12" cy="12" r="3"/></svg>';
function addPasswordPeek(input) {
  if (input.parentElement?.classList.contains("pw-wrap")) return;
  const wrap = document.createElement("span");
  wrap.className = "pw-wrap";
  input.replaceWith(wrap);
  wrap.appendChild(input);
  const eye = document.createElement("button");
  eye.type = "button";
  eye.className = "pw-peek";
  eye.title = "Hold to show password";
  eye.setAttribute("aria-label", "Hold to show password");
  eye.innerHTML = EYE_SVG;
  wrap.appendChild(eye);
  const show = e => { e.preventDefault(); input.type = "text"; eye.classList.add("on"); };
  const hide = () => { input.type = "password"; eye.classList.remove("on"); };
  eye.addEventListener("pointerdown", show);           // preventDefault keeps focus in the box
  ["pointerup", "pointerleave", "pointercancel", "blur"].forEach(ev => eye.addEventListener(ev, hide));
  eye.addEventListener("keydown", e => { if (e.key === " " || e.key === "Enter") show(e); });
  eye.addEventListener("keyup", hide);
  eye.addEventListener("click", e => e.preventDefault());
}

document.querySelectorAll("input[data-peek]").forEach(addPasswordPeek);
