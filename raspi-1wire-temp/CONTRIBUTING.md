# Contributing

The best way to contribute changes to `raspi-1wire-temp` is to fork the GitLab 
project, make the changes local to your forked repository, then submit a Merge
Request through GitLab.

Although there is not formal coding standards used with `raspi-1wire-temp`, your 
Merge Request is more likely to be successful if your changes are consistent 
with the existing coding style.  This includes indentations, variable/method 
names, and even the amount of comments and documentation.  

Merge Requests are also more likely to be successful if the commits also include
new unit tests to ensure the new or fixed functionality actually works.  Though
there are _some_ use cases where more tests will not be necessary.  This will be
determined on a case-by-case basis.

When in doubt, create unit tests and add code comments, and add as much 
information as you can to the Merge Request.  The main developer will respond as
soon as possible.

Finally, the commands below are intended for the main developer of 
`raspi-1wire-temp`, or anyone given maintainer/developer rights on the GitLab 
project.

## Committing a new version.

The first thing is to open the `.bumpversion.cfg` config and update the version
number accordingly.  Lastly we can use 
[bumpversion](https://pypi.org/project/bumpversion) to increment and commit the
new version number.

```bash
pip3 install --user bumpversion
bumpversion patch
# or "bumpversion minor", if it's appropriate!
# or "bumpversion major", if it's appropriate!!
git push
git push --tags
```

## Publish new versions.

```bash
# Setup up username/password variables.
NPM_USERNAME=...
NPM_PASSWORD=...
npm login

# Publish the production code.
npm publish
```
