# Julia repository Microprint example

In this repository. There's an example of how to use the microprint generator and visualization tools to automatically create a representation of the logs of a GitHub workflow.

For that, we use the GitHub action [Generate a microprint of the logs of a workflow job
](https://github.com/marketplace/actions/generate-a-microprint-of-the-logs-of-a-workflow-job)

# Usage

## Worflow
First, the action must be added to the workflow. In this example, we want to get microprints for the logs of the "testJuliaPackages" workflow job. So we add the following job to the main workflow file [main.yml](.github/workflows/main.yml)

```
build-microprint:
          runs-on: ubuntu-latest

          needs: testJuliaPackages

          strategy:
            fail-fast: false
            matrix:
              os: [ubuntu-latest, windows-latest]
              julia_version: [1.8]

          steps:
            - name: Checkout code
              uses: actions/checkout@v3

            - name: Pull changes
              run: git pull

            - name: Get microprint of check-examples job logs
              uses: AlphaSteam/microprint-generator@v4
              with:
                  job_name: Test Julia Packages
                  microprint_filename: microprint
                  microprint_path: ./microprints/
                  microprint_config_path: ./
                  microprint_config_filename: microprint-config
                  microprint_visualizer_link_filename: microprint-visualizer
                  microprint_visualizer_link_path: ./microprints/visualizers/
                  log_path: ./microprints/logs/

            - name: Commit microprint
              uses: EndBug/add-and-commit@v9
              with:
                message: Updated microprint
                pull: '--rebase --autostash -s ort -X theirs'

            - name: Get Actions user id
              id: get_uid
              run: |
                actions_user_id=`id -u $USER`
                echo $actions_user_id
                echo ::set-output name=uid::$actions_user_id

            - name: Correct Ownership in GITHUB_WORKSPACE directory
              uses: peter-murray/reset-workspace-ownership-action@v1
              with:
                user_id: ${{ steps.get_uid.outputs.uid }}
```

## Microprint rules

We need to set the rules for the microprint. These define what lines are highlighted inside it and with what text and background color. For this we need to create a config file.

In this example the config file is [microprint-config.json](microprint-config.json).

## Visualization

The files generated from the microprint generation action in the workflow, are saved in the folder specified in the inputs of the action. When it's defined in the workflow file. In this example, the files are inside the folder [microprints](microprints).

Inside that folder there are the svg files of the generated microprints, a folder for the log files (optional) and a folder for the visualizers (optional).

The visualizers correspond to markdown files with a link to the visualizer page with the microprint loaded. [Microprint visualizer](https://github.com/AlphaSteam/microprint-visualizer)
