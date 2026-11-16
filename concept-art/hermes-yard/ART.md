# Hermes Agent's wings

In every Yard, Hermes Agent's hall and character are the Shell's, finished
in white and Hermes blue (`#0000f2`) by the renderer, and the character wears
the wings of Hermes on its head. The wings are `web/yard/assets/hermes_wings.glb`.

They come from the Winged Orbital Hacker, the Shell piece of the Mount
Olympus community theme, made in Agent Guild: Builders and Agent Guild:
Studio (CC BY 4.0). `wings.mjs` cuts its head wings out, leaves the ankle
wings, colours the trim Hermes blue and records the head they were made for:

```sh
node concept-art/hermes-yard/wings.mjs <winged-hacker/character.glb>
```

The Yard fits them to each character's `Head` bone when it loads, measured
from the vertices that follow the head in the bind pose, so any world, and
any Shell piece with a `Head` bone, gets them without a model of its own.
