I have a doubt about effectful interfaces. I have a lib which exposes a bunch of functions to call remote functions in different ways. One, for example, asks for a lambda client (aws sdk) to make invocations.

I have the need to consume such functions from a repo which doesn't have effect. Is there an existing combinator or such which trasposes the requirements to normal function arguments, maybe using a map or a record or something?

```
class Test {}

const test = new Test()
```
