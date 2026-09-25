export default {
  ADD_EXTERNAL_DATASET: `#graphql
    mutation AddExternalDataset(
      $planId: Int!,
      $simulationDatasetId: Int,
      $datasetStart: String!,
      $profileSet: ProfileSet!) {
        addExternalDataset(
          planId: $planId,
          simulationDatasetId: $simulationDatasetId,
          datasetStart: $datasetStart,
          profileSet: $profileSet) {
          datasetId
        }
    }
  `,
  CREATE_ACTIVITY_DIRECTIVES: `#graphql
    mutation CreateActivityDirectives($activityDirectivesInsertInput: [activity_directive_insert_input!]!) {
      insert_activity_directive(objects: $activityDirectivesInsertInput) {
        returning {
          id
          type
        }
      }
    }
  `,
  CREATE_PLAN: `#graphql
    mutation CreatePlan($plan: plan_insert_input!) {
      createPlan: insert_plan_one(object: $plan) {
        created_at
        collaborators {
          collaborator
        }
        duration
        id
        owner
        revision
        start_time
        simulations {
          id
        }
      }
    }
  `,
  CREATE_PLAN_TAGS: `#graphql
    mutation CreatePlanTags($tags: [plan_tags_insert_input!]!) {
      insert_plan_tags(objects: $tags, on_conflict: {
        constraint: plan_tags_pkey,
        update_columns: []
      }) {
        affected_rows
      }
    }
  `,
  CREATE_TAGS: `#graphql
    mutation CreateTags($tags: [tags_insert_input!]!) {
      insert_tags(objects: $tags) {
        returning {
          color
          created_at
          id
          name
          owner
        }
      }
    }
  `,
  DELETE_EXTERNAL_DATASET: `#graphql
    mutation DeleteExternalDataset($id: Int!) {
      delete_dataset_by_pk(id: $id) {
        id
      }
    }
  `,
  DELETE_PLAN: `#graphql
    mutation DeletePlan($id: Int!) {
      deletePlan: delete_plan_by_pk(id: $id) {
        id
      }
    }
  `,
  DELETE_TAGS: `#graphql
    mutation DeleteTags($tagIds: [Int!]! = []) {
      delete_tags(
        where: {
          id: { _in: $tagIds }
        }
      ) {
        affected_rows
      }
    }
  `,
  EXTEND_EXTERNAL_DATASET: `#graphql
    mutation ExtendExternalDataset($datasetId: Int!, $profileSet: ProfileSet!) {
      extendExternalDataset(datasetId: $datasetId, profileSet: $profileSet) {
        datasetId
      }
    }
  `,
  GET_MUTATION_ROOT_FIELDS: `#graphql
    query MutationRootFields {
      __type(name: "mutation_root") {
        fields {
          name
        }
      }
    }
  `,
  GET_PLAN_BY_NAME: `#graphql
    query GetPlanByName($name: String!) {
      plan(where: { name: { _eq: $name } }) {
        id
      }
    }
  `,
  GET_TAGS: `#graphql
    query GetTags {
      tags(order_by: { name: desc })  {
        color
        created_at
        id
        name
        owner
      }
    }
  `,
  INSERT_NON_EXECUTABLE_MODEL: `#graphql
    mutation InsertNonExecutableModel(
      $definition_file_id: Int!,
      $owner: String!,
      $name: String!,
      $mission: String!,
      $version: String!,
      $description: String!) {
        insert_mission_model_one(object: {
          definition_file_id: $definition_file_id,
          description: $description,
          mission: $mission,
          name: $name,
          version: $version,
          owner: $owner,
          is_executable: false
        }) {
          id
        }
    }
  `,
  MODEL_TYPE_REFRESH_STATUS: `#graphql
    query ModelTypeRefreshStatus($modelId: Int!) {
      mission_model_by_pk(id: $modelId) {
        refresh_activity_type_logs(order_by: { created_at: desc }, limit: 1) {
          pending
          success
          error_message
        }
        refresh_resource_type_logs(order_by: { created_at: desc }, limit: 1) {
          pending
          success
          error_message
        }
        refresh_model_parameter_logs(order_by: { created_at: desc }, limit: 1) {
          pending
          success
          error_message
        }
      }
    }
  `,
  UPDATE_ACTIVITY_DIRECTIVES: `#graphql
    mutation UpdateActivityDirective($updates: [activity_directive_updates!]!) {
      update_activity_directive_many(
        updates: $updates
      ) {
        affected_rows
      }
    }
  `,
  UPDATE_SIMULATION: `#graphql
    mutation InitialSimulationUpdate($plan_id: Int!, $simulation: simulation_set_input!) {
      update_simulation(where: {plan_id: {_eq: $plan_id}}, _set: $simulation) {
        returning {
          id
        }
      }
    }
  `,
};
