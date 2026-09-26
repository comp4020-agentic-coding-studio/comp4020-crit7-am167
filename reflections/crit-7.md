# Crit 7 reflection

## What was the breakthrough that moved the work forward?

The breakthrough was deciding that everything had to happen inside the map.
The first version put a list under the campus map and the floor plan and
booking form under the canvas, so the map was really just decoration on top
of a normal booking page. Once I said I didn't want to scroll down to manage
a booking, the app had a clear direction: campus, building, level, room, each
one a stage of the same map. Most of what came after, like the floating
panel, the room dialog and the camera framing around them, followed from that
one decision.

## What did this work change about who I want to be as a software developer?

It showed me how much of the result depends on how clearly I say what I
want. Every time I left a gap, the agent filled it with a reasonable guess
that wasn't mine: a list below the map, floors lined with tutorial rooms, and
then more than 10,000 desks when I asked for "mostly desks". None of those
were bugs, and the tests were green for all of them. I only spotted them by
opening the page and manually verifying. I want to be a developer who checks
the rendered result instead of trusting the checks, and who notices when a
guess has been built in as a fact.
